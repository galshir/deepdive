import { describe, expect, it } from 'vitest';
import { buildCountQuery, buildTableQuery } from '../../src/core/sql/tableQuery';
import { col, customers, table } from '../helpers/fixtures';

describe('buildTableQuery', () => {
  it('selects all columns ordered by primary key with limit+1', () => {
    const q = buildTableQuery({ database: 'shop', table: 'customers', limit: 100, offset: 200 }, customers);
    expect(q.sql).toBe('SELECT `id`, `email`, `status`, `is_vip`, `created_at`\nFROM `shop`.`customers`\nORDER BY `id` ASC\nLIMIT ? OFFSET ?');
    expect(q.params).toEqual([101, 200]);
    expect(q.hiddenColumns).toEqual([]);
  });

  it('respects column choice/order and appends hidden primary key columns', () => {
    const q = buildTableQuery({ database: 'shop', table: 'customers', columns: ['status', 'email'], limit: 10, offset: 0 }, customers);
    expect(q.columns).toEqual(['status', 'email', 'id']);
    expect(q.hiddenColumns).toEqual(['id']);
  });

  it('applies filters and multi-column sorting', () => {
    const q = buildTableQuery(
      {
        database: 'shop',
        table: 'customers',
        filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'status', operator: 'eq', value: 'active' }] },
        sort: [{ column: 'created_at', direction: 'desc' }],
        limit: 50,
        offset: 0,
      },
      customers,
    );
    expect(q.sql).toContain('WHERE `status` = ?');
    expect(q.sql).toContain('ORDER BY `created_at` DESC, `id` ASC');
    expect(q.params).toEqual(['active', 51, 0]);
  });

  it('does not add an ORDER BY for tables without a primary key', () => {
    const t = table('a', 'logs', [col('logs', 'msg')], []);
    expect(buildTableQuery({ database: 'a', table: 'logs', limit: 5, offset: 0 }, t).sql).not.toContain('ORDER BY');
  });

  it('rejects unknown/duplicate columns, bad sort and mismatched tables', () => {
    expect(() => buildTableQuery({ database: 'shop', table: 'customers', columns: ['nope'], limit: 1, offset: 0 }, customers)).toThrow(/Unknown column/);
    expect(() => buildTableQuery({ database: 'shop', table: 'customers', columns: ['id', 'id'], limit: 1, offset: 0 }, customers)).toThrow(/twice/);
    expect(() => buildTableQuery({ database: 'shop', table: 'customers', sort: [{ column: 'x', direction: 'asc' }], limit: 1, offset: 0 }, customers)).toThrow();
    expect(() => buildTableQuery({ database: 'shop', table: 'customers', sort: [{ column: 'id', direction: 'sideways' as never }], limit: 1, offset: 0 }, customers)).toThrow();
    expect(() => buildTableQuery({ database: 'other', table: 'customers', limit: 1, offset: 0 }, customers)).toThrow(/does not match/);
    expect(() => buildTableQuery({ database: 'shop', table: 'customers', limit: 0, offset: 0 }, customers)).toThrow(/limit/);
    expect(() => buildTableQuery({ database: 'shop', table: 'customers', limit: 1, offset: -1 }, customers)).toThrow(/offset/);
  });

  it('builds an explicit COUNT query', () => {
    expect(buildCountQuery(customers)).toEqual({ sql: 'SELECT COUNT(*) AS `count` FROM `shop`.`customers`', params: [] });
  });
});
