import type { CellValue, ColumnInfo, FilterCondition, FilterGroup, FilterNode, FilterScalar } from '../../shared/model';
import { validationError } from '../errors';
import { escapeLike, LIKE_ESCAPE_CHAR } from './identifiers';

export interface SqlFragment {
  sql: string;
  params: CellValue[];
}

/** Resolves a (source, column) reference to a quoted SQL expression. Must throw for unknown columns. */
export type ColumnResolver = (source: string | undefined, column: string) => { sql: string; column: ColumnInfo };

export const MAX_FILTER_DEPTH = 6;
export const MAX_FILTER_CONDITIONS = 200;
export const MAX_IN_VALUES = 1000;

const LIKE = `LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`;
const NOT_LIKE = `NOT LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'`;

/** Parameter values are always scalars; booleans are bound as 1/0 so MySQL and SQLite agree. */
export function toParam(value: FilterScalar): CellValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function requireValue(cond: FilterCondition, value: FilterScalar | undefined, label = 'a value'): FilterScalar {
  if (value === undefined) throw validationError(`Filter on "${cond.column}" needs ${label}`);
  return value;
}

function requireNonNull(cond: FilterCondition, value: FilterScalar | undefined): Exclude<FilterScalar, null> {
  const v = requireValue(cond, value);
  if (v === null) throw validationError(`Filter on "${cond.column}" cannot compare with NULL — use "is null" instead`);
  return v;
}

function likeValue(cond: FilterCondition, prefix: string, suffix: string): string {
  const v = requireNonNull(cond, cond.value);
  return `${prefix}${escapeLike(String(v))}${suffix}`;
}

export function buildCondition(cond: FilterCondition, resolve: ColumnResolver): SqlFragment {
  const col = resolve(cond.source, cond.column).sql;
  switch (cond.operator) {
    case 'eq': {
      const v = requireValue(cond, cond.value);
      return v === null ? { sql: `${col} IS NULL`, params: [] } : { sql: `${col} = ?`, params: [toParam(v)] };
    }
    case 'neq': {
      const v = requireValue(cond, cond.value);
      return v === null ? { sql: `${col} IS NOT NULL`, params: [] } : { sql: `${col} <> ?`, params: [toParam(v)] };
    }
    case 'gt': return { sql: `${col} > ?`, params: [toParam(requireNonNull(cond, cond.value))] };
    case 'gte': return { sql: `${col} >= ?`, params: [toParam(requireNonNull(cond, cond.value))] };
    case 'lt': return { sql: `${col} < ?`, params: [toParam(requireNonNull(cond, cond.value))] };
    case 'lte': return { sql: `${col} <= ?`, params: [toParam(requireNonNull(cond, cond.value))] };
    case 'contains': return { sql: `${col} ${LIKE}`, params: [likeValue(cond, '%', '%')] };
    case 'not_contains': return { sql: `${col} ${NOT_LIKE}`, params: [likeValue(cond, '%', '%')] };
    case 'starts_with': return { sql: `${col} ${LIKE}`, params: [likeValue(cond, '', '%')] };
    case 'ends_with': return { sql: `${col} ${LIKE}`, params: [likeValue(cond, '%', '')] };
    case 'in':
    case 'not_in': {
      const values = cond.values ?? [];
      if (values.length === 0) throw validationError(`Filter on "${cond.column}" needs at least one value`);
      if (values.length > MAX_IN_VALUES) throw validationError(`Too many values (max ${MAX_IN_VALUES})`);
      if (values.some((v) => v === null)) throw validationError('IN lists cannot contain NULL — add an "is null" condition instead');
      const placeholders = values.map(() => '?').join(', ');
      return { sql: `${col} ${cond.operator === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`, params: values.map(toParam) };
    }
    case 'between': {
      const a = requireNonNull(cond, cond.value);
      const b = requireNonNull(cond, cond.value2);
      return { sql: `${col} BETWEEN ? AND ?`, params: [toParam(a), toParam(b)] };
    }
    case 'is_null': return { sql: `${col} IS NULL`, params: [] };
    case 'is_not_null': return { sql: `${col} IS NOT NULL`, params: [] };
    case 'is_true': return { sql: `${col} <> 0`, params: [] };
    case 'is_false': return { sql: `${col} = 0`, params: [] };
    case 'is_empty': return { sql: `${col} = ''`, params: [] };
    case 'is_not_empty': return { sql: `${col} <> ''`, params: [] };
    default: {
      const op: never = cond.operator;
      throw validationError(`Unknown filter operator ${String(op)}`);
    }
  }
}

/** Compiles a filter tree into a WHERE fragment (without the WHERE keyword). Returns null for empty filters. */
export function buildFilter(group: FilterGroup | undefined, resolve: ColumnResolver): SqlFragment | null {
  if (!group) return null;
  let conditions = 0;
  const walk = (node: FilterNode, depth: number): SqlFragment | null => {
    if (node.kind === 'condition') {
      if (++conditions > MAX_FILTER_CONDITIONS) throw validationError(`Too many filter conditions (max ${MAX_FILTER_CONDITIONS})`);
      return buildCondition(node, resolve);
    }
    if (depth > MAX_FILTER_DEPTH) throw validationError(`Filter groups are nested too deeply (max ${MAX_FILTER_DEPTH})`);
    if (node.combinator !== 'and' && node.combinator !== 'or') throw validationError('Invalid filter combinator');
    const parts = node.children.map((c) => walk(c, depth + 1)).filter((p): p is SqlFragment => p !== null);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0]!;
    const joiner = node.combinator === 'and' ? ' AND ' : ' OR ';
    return {
      sql: parts.map((p) => `(${p.sql})`).join(joiner),
      params: parts.flatMap((p) => p.params),
    };
  };
  return walk(group, 0);
}

export function emptyFilter(id = 'root'): FilterGroup {
  return { kind: 'group', id, combinator: 'and', children: [] };
}
