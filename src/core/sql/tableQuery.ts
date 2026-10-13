import type { CellValue, ColumnInfo, FilterGroup, TableDetails, TableQueryRequest } from '../../shared/model';
import { validationError } from '../errors';
import { buildFilter, type ColumnResolver } from './filters';
import { qualifiedTable, quoteIdent } from './identifiers';

export interface BuiltTableQuery {
  sql: string;
  params: CellValue[];
  columns: string[];
  hiddenColumns: string[];
}

export function columnMap(details: TableDetails): Map<string, ColumnInfo> {
  return new Map(details.columns.map((c) => [c.name, c]));
}

function assertSameTable(details: TableDetails, database: string, table: string): void {
  if (details.table.database !== database || details.table.name !== table) {
    throw validationError('Table metadata does not match the request');
  }
}

export function singleTableResolver(details: TableDetails): ColumnResolver {
  const cols = columnMap(details);
  return (source, column) => {
    if (source !== undefined && source !== details.table.name) throw validationError(`Unknown table "${source}" in filter`);
    const info = cols.get(column);
    if (!info) throw validationError(`Unknown column "${column}" in table "${details.table.name}"`);
    return { sql: quoteIdent(info.name), column: info };
  };
}

function whereClause(filter: FilterGroup | undefined, details: TableDetails): { sql: string; params: CellValue[] } {
  const built = buildFilter(filter, singleTableResolver(details));
  return built ? { sql: ` WHERE ${built.sql}`, params: built.params } : { sql: '', params: [] };
}

/**
 * Builds the paged SELECT used by the data browser. Every identifier is checked against metadata,
 * values are parameterized and one extra row is requested to detect whether more pages exist.
 */
export function buildTableQuery(req: TableQueryRequest, details: TableDetails): BuiltTableQuery {
  assertSameTable(details, req.database, req.table);
  const cols = columnMap(details);
  const requested = req.columns && req.columns.length > 0 ? req.columns : details.columns.map((c) => c.name);
  const seen = new Set<string>();
  for (const c of requested) {
    if (!cols.has(c)) throw validationError(`Unknown column "${c}" in table "${req.table}"`);
    if (seen.has(c)) throw validationError(`Column "${c}" selected twice`);
    seen.add(c);
  }
  const hiddenColumns = details.primaryKey.filter((pk) => !seen.has(pk));
  const selected = [...requested, ...hiddenColumns];
  const where = whereClause(req.filter, details);

  const sort = req.sort ?? [];
  for (const s of sort) {
    if (!cols.has(s.column)) throw validationError(`Unknown sort column "${s.column}"`);
    if (s.direction !== 'asc' && s.direction !== 'desc') throw validationError('Invalid sort direction');
  }
  const orderParts = sort.map((s) => `${quoteIdent(s.column)} ${s.direction === 'asc' ? 'ASC' : 'DESC'}`);
  // A primary-key tiebreaker keeps OFFSET pagination stable.
  for (const pk of details.primaryKey) if (!sort.some((s) => s.column === pk)) orderParts.push(`${quoteIdent(pk)} ASC`);

  if (!Number.isInteger(req.limit) || req.limit < 1) throw validationError('Invalid limit');
  if (!Number.isInteger(req.offset) || req.offset < 0) throw validationError('Invalid offset');

  const sql =
    `SELECT ${selected.map((c) => quoteIdent(c)).join(', ')}\nFROM ${qualifiedTable(req.database, req.table)}` +
    (where.sql ? `\n${where.sql.trim()}` : '') +
    (orderParts.length ? `\nORDER BY ${orderParts.join(', ')}` : '') +
    `\nLIMIT ? OFFSET ?`;
  return { sql, params: [...where.params, req.limit + 1, req.offset], columns: selected, hiddenColumns };
}

export function buildCountQuery(details: TableDetails, filter?: FilterGroup): { sql: string; params: CellValue[] } {
  const where = whereClause(filter, details);
  return {
    sql: `SELECT COUNT(*) AS ${quoteIdent('count')} FROM ${qualifiedTable(details.table.database, details.table.name)}${where.sql}`,
    params: where.params,
  };
}
