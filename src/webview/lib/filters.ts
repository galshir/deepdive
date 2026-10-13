import type { FilterCondition, FilterGroup, FilterNode, FilterOperator } from '../../shared/model';
import type { ColumnCategory } from './util';
import { uid } from './util';

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  in: 'is one of',
  not_in: 'is not one of',
  between: 'between',
  is_null: 'is NULL',
  is_not_null: 'is not NULL',
  is_true: 'is true',
  is_false: 'is false',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};

const COMMON: FilterOperator[] = ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'];

export function operatorsFor(category: ColumnCategory): FilterOperator[] {
  switch (category) {
    case 'number':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'is_null', 'is_not_null'];
    case 'date':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null', 'contains'];
    case 'boolean':
      return ['is_true', 'is_false', 'eq', 'neq', 'is_null', 'is_not_null'];
    case 'text':
      return ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_empty', 'is_not_empty', 'is_null', 'is_not_null', 'gt', 'lt'];
    default:
      return [...COMMON, 'contains', 'gt', 'lt'];
  }
}

export const NO_VALUE: ReadonlySet<FilterOperator> = new Set(['is_null', 'is_not_null', 'is_true', 'is_false', 'is_empty', 'is_not_empty']);

export function emptyGroup(combinator: 'and' | 'or' = 'and'): FilterGroup {
  return { kind: 'group', id: uid('g'), combinator, children: [] };
}

export function newCondition(column: string, category: ColumnCategory, source?: string, operator?: FilterOperator): FilterCondition {
  const op = operator ?? (category === 'boolean' ? 'is_true' : category === 'text' ? 'contains' : 'eq');
  return { kind: 'condition', id: uid('f'), column, source, operator: op, value: NO_VALUE.has(op) ? undefined : '' };
}

export function mapNode(group: FilterGroup, id: string, fn: (n: FilterNode) => FilterNode | null): FilterGroup {
  const walk = (g: FilterGroup): FilterGroup => ({
    ...g,
    children: g.children.flatMap((c) => {
      if (c.id === id) {
        const r = fn(c);
        return r ? [r] : [];
      }
      return c.kind === 'group' ? [walk(c)] : [c];
    }),
  });
  if (group.id === id) {
    const r = fn(group);
    return r && r.kind === 'group' ? r : emptyGroup(group.combinator);
  }
  return walk(group);
}

export function addChild(group: FilterGroup, parentId: string, child: FilterNode): FilterGroup {
  if (group.id === parentId) return { ...group, children: [...group.children, child] };
  return { ...group, children: group.children.map((c) => (c.kind === 'group' ? addChild(c, parentId, child) : c)) };
}

export function countConditions(group: FilterGroup | undefined): number {
  if (!group) return 0;
  return group.children.reduce((n, c) => n + (c.kind === 'condition' ? 1 : countConditions(c)), 0);
}

/** Converts text input to a typed filter value: numbers for numeric columns, strings otherwise. */
export function parseValue(raw: string, category: ColumnCategory): string | number {
  if (category === 'number' && raw.trim() !== '' && /^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
  return raw;
}

/** Removes empty-value conditions so a half-filled builder can still be applied. */
export function pruneIncomplete(group: FilterGroup): FilterGroup {
  return {
    ...group,
    children: group.children
      .map((c) => (c.kind === 'group' ? pruneIncomplete(c) : c))
      .filter((c) => {
        if (c.kind === 'group') return c.children.length > 0;
        if (NO_VALUE.has(c.operator)) return true;
        if (c.operator === 'in' || c.operator === 'not_in') return (c.values?.length ?? 0) > 0;
        if (c.operator === 'between') return c.value !== undefined && c.value !== '' && c.value2 !== undefined && c.value2 !== '';
        return c.value !== undefined && c.value !== '';
      }),
  };
}
