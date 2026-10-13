import { describe, expect, it } from 'vitest';
import { compileQueryModel } from '../../src/core/sql/queryModel';
import type { QueryModel } from '../../src/shared/model';
import { lookup } from '../helpers/fixtures';

const base = (patch: Partial<QueryModel> = {}): QueryModel => ({
  tables: [{ alias: 'c', database: 'shop', table: 'customers' }],
  joins: [],
  columns: [],
  filter: { kind: 'group', id: 'root', combinator: 'and', children: [] },
  groupBy: [],
  orderBy: [],
  limit: 100,
  distinct: false,
  ...patch,
});

describe('compileQueryModel', () => {
  it('selects * when no columns are chosen', () => {
    const q = compileQueryModel(base(), lookup);
    expect(q.sql).toBe('SELECT *\nFROM `shop`.`customers` AS `c`\nLIMIT ?');
    expect(q.params).toEqual([100]);
    expect(q.notes[0]).toMatch(/all columns/);
  });

  it('builds joins only from explicit join definitions', () => {
    const q = compileQueryModel(
      base({
        tables: [
          { alias: 'c', database: 'shop', table: 'customers' },
          { alias: 'o', database: 'shop', table: 'orders' },
        ],
        joins: [{ id: 'j', type: 'left', leftAlias: 'c', leftColumn: 'id', rightAlias: 'o', rightColumn: 'customer_id' }],
        columns: [
          { id: '1', source: 'c', column: 'email' },
          { id: '2', source: 'o', column: 'total', aggregate: 'sum' },
        ],
        filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'x', source: 'c', column: 'status', operator: 'eq', value: 'active' }] },
        orderBy: [{ source: 'c', column: 'email', direction: 'asc' }],
        limit: null,
      }),
      lookup,
    );
    expect(q.sql).toBe(
      [
        'SELECT `c`.`email`,',
        '       SUM(`o`.`total`) AS `sum_total`',
        'FROM `shop`.`customers` AS `c`',
        '  LEFT JOIN `shop`.`orders` AS `o` ON `c`.`id` = `o`.`customer_id`',
        'WHERE `c`.`status` = ?',
        'GROUP BY `c`.`email`',
        'ORDER BY `c`.`email` ASC',
      ].join('\n'),
    );
    expect(q.params).toEqual(['active']);
    expect(q.notes.join(' ')).toMatch(/GROUP BY/);
  });

  it('flips outer joins when the joined table is on the left side', () => {
    const q = compileQueryModel(
      base({
        tables: [
          { alias: 'c', database: 'shop', table: 'customers' },
          { alias: 'o', database: 'shop', table: 'orders' },
        ],
        joins: [{ id: 'j', type: 'left', leftAlias: 'o', leftColumn: 'customer_id', rightAlias: 'c', rightColumn: 'id' }],
      }),
      lookup,
    );
    expect(q.sql).toContain('RIGHT JOIN `shop`.`orders` AS `o` ON `o`.`customer_id` = `c`.`id`');
  });

  it('refuses to invent a join for unconnected tables', () => {
    expect(() =>
      compileQueryModel(
        base({
          tables: [
            { alias: 'c', database: 'shop', table: 'customers' },
            { alias: 'o', database: 'shop', table: 'orders' },
          ],
        }),
        lookup,
      ),
    ).toThrow(/not joined/);
  });

  it('supports DISTINCT, COUNT(*) and explicit aliases', () => {
    const q = compileQueryModel(
      base({ distinct: true, columns: [{ id: '1', source: 'c', column: '*', aggregate: 'count', as: 'n' }, { id: '2', source: 'c', column: 'status' }] }),
      lookup,
    );
    expect(q.sql.startsWith('SELECT DISTINCT COUNT(*) AS `n`,')).toBe(true);
  });

  it('validates aliases, columns and duplicate output names', () => {
    expect(() => compileQueryModel(base({ tables: [{ alias: 'bad alias', database: 'shop', table: 'customers' }] }), lookup)).toThrow(/alias/);
    expect(() => compileQueryModel(base({ columns: [{ id: '1', source: 'c', column: 'nope' }] }), lookup)).toThrow(/Unknown column/);
    expect(() => compileQueryModel(base({ columns: [{ id: '1', source: 'zz', column: 'id' }] }), lookup)).toThrow(/Unknown table alias/);
    expect(() =>
      compileQueryModel(base({ columns: [{ id: '1', source: 'c', column: 'id', as: 'x' }, { id: '2', source: 'c', column: 'email', as: 'x' }] }), lookup),
    ).toThrow(/twice/);
    expect(() => compileQueryModel(base({ columns: [{ id: '1', source: 'c', column: '*', aggregate: 'sum' }] }), lookup)).toThrow(/COUNT/);
    expect(() => compileQueryModel(base({ tables: [] }), lookup)).toThrow(/at least one/);
    expect(() => compileQueryModel(base({ tables: [{ alias: 'c', database: 'shop', table: 'ghost' }] }), lookup)).toThrow();
  });
});
