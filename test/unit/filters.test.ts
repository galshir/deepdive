import { describe, expect, it } from 'vitest';
import { buildFilter } from '../../src/core/sql/filters';
import { singleTableResolver } from '../../src/core/sql/tableQuery';
import type { FilterCondition, FilterGroup, FilterNode } from '../../src/shared/model';
import { customers } from '../helpers/fixtures';

const resolve = singleTableResolver(customers);
const cond = (c: Partial<FilterCondition>): FilterCondition => ({ kind: 'condition', id: Math.random().toString(), column: 'status', operator: 'eq', ...c });
const group = (children: FilterNode[], combinator: 'and' | 'or' = 'and'): FilterGroup => ({ kind: 'group', id: 'g', combinator, children });

describe('buildFilter', () => {
  it('returns null for empty filters', () => {
    expect(buildFilter(undefined, resolve)).toBeNull();
    expect(buildFilter(group([]), resolve)).toBeNull();
    expect(buildFilter(group([group([])]), resolve)).toBeNull();
  });

  it('parameterizes values', () => {
    expect(buildFilter(group([cond({ value: 'active' })]), resolve)).toEqual({ sql: '`status` = ?', params: ['active'] });
  });

  it.each<[Partial<FilterCondition>, string, unknown[]]>([
    [{ operator: 'neq', value: 'x' }, '`status` <> ?', ['x']],
    [{ operator: 'eq', value: null }, '`status` IS NULL', []],
    [{ operator: 'neq', value: null }, '`status` IS NOT NULL', []],
    [{ column: 'id', operator: 'gt', value: 5 }, '`id` > ?', [5]],
    [{ column: 'id', operator: 'gte', value: '5' }, '`id` >= ?', ['5']],
    [{ column: 'id', operator: 'lt', value: 5 }, '`id` < ?', [5]],
    [{ column: 'id', operator: 'lte', value: 5 }, '`id` <= ?', [5]],
    [{ operator: 'contains', value: '50%_' }, "`status` LIKE ? ESCAPE '!'", ['%50!%!_%']],
    [{ operator: 'not_contains', value: 'a' }, "`status` NOT LIKE ? ESCAPE '!'", ['%a%']],
    [{ operator: 'starts_with', value: 'a' }, "`status` LIKE ? ESCAPE '!'", ['a%']],
    [{ operator: 'ends_with', value: 'a' }, "`status` LIKE ? ESCAPE '!'", ['%a']],
    [{ operator: 'in', values: ['a', 'b'] }, '`status` IN (?, ?)', ['a', 'b']],
    [{ operator: 'not_in', values: [1] }, '`status` NOT IN (?)', [1]],
    [{ column: 'created_at', operator: 'between', value: '2024-01-01', value2: '2024-12-31' }, '`created_at` BETWEEN ? AND ?', ['2024-01-01', '2024-12-31']],
    [{ operator: 'is_null' }, '`status` IS NULL', []],
    [{ operator: 'is_not_null' }, '`status` IS NOT NULL', []],
    [{ column: 'is_vip', operator: 'is_true' }, '`is_vip` <> 0', []],
    [{ column: 'is_vip', operator: 'is_false' }, '`is_vip` = 0', []],
    [{ column: 'is_vip', operator: 'eq', value: true }, '`is_vip` = ?', [1]],
    [{ operator: 'is_empty' }, "`status` = ''", []],
    [{ operator: 'is_not_empty' }, "`status` <> ''", []],
  ])('compiles %j', (c, sql, params) => {
    expect(buildFilter(group([cond(c)]), resolve)).toEqual({ sql, params });
  });

  it('combines nested AND/OR groups with parentheses', () => {
    const f = group([cond({ value: 'active' }), group([cond({ column: 'is_vip', operator: 'is_true' }), cond({ column: 'id', operator: 'lt', value: 10 })], 'or')]);
    expect(buildFilter(f, resolve)).toEqual({ sql: '(`status` = ?) AND ((`is_vip` <> 0) OR (`id` < ?))', params: ['active', 10] });
  });

  it('keeps injection attempts inside parameters', () => {
    const evil = "x' OR 1=1; DROP TABLE customers; --";
    const out = buildFilter(group([cond({ value: evil })]), resolve)!;
    expect(out.sql).toBe('`status` = ?');
    expect(out.params).toEqual([evil]);
  });

  it('rejects unknown columns, including injection via column names', () => {
    expect(() => buildFilter(group([cond({ column: 'nope' })]), resolve)).toThrow(/Unknown column/);
    expect(() => buildFilter(group([cond({ column: 'status` = 1 OR `1' })]), resolve)).toThrow(/Unknown column/);
  });

  it('rejects missing values and NULL comparisons', () => {
    expect(() => buildFilter(group([cond({ value: undefined })]), resolve)).toThrow(/needs a value/);
    expect(() => buildFilter(group([cond({ column: 'id', operator: 'gt', value: null })]), resolve)).toThrow(/NULL/);
    expect(() => buildFilter(group([cond({ operator: 'in', values: [] })]), resolve)).toThrow(/at least one/);
    expect(() => buildFilter(group([cond({ operator: 'between', value: 1 })]), resolve)).toThrow();
  });

  it('rejects unknown operators', () => {
    expect(() => buildFilter(group([cond({ operator: 'raw' as never, value: 1 })]), resolve)).toThrow(/Unknown filter operator/);
  });

  it('limits depth and size', () => {
    let deep: FilterGroup = group([cond({ value: 'a' })]);
    for (let i = 0; i < 10; i++) deep = group([deep]);
    expect(() => buildFilter(deep, resolve)).toThrow(/nested too deeply/);
    const wide = group(Array.from({ length: 201 }, () => cond({ value: 'a' })));
    expect(() => buildFilter(wide, resolve)).toThrow(/Too many/);
  });
});
