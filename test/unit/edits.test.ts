import { describe, expect, it } from 'vitest';
import { buildEditStatements } from '../../src/core/sql/edits';
import { col, customers, table } from '../helpers/fixtures';

describe('buildEditStatements', () => {
  it('builds single-row UPDATE and DELETE statements addressed by primary key', () => {
    const st = buildEditStatements(customers, [{ key: { id: 7 }, changes: { status: 'banned', is_vip: false } }], [{ id: 9 }], 'mysql');
    expect(st).toEqual([
      { sql: 'UPDATE `shop`.`customers` SET `status` = ?, `is_vip` = ? WHERE `id` = ? LIMIT 1', params: ['banned', 0, 7] },
      { sql: 'DELETE FROM `shop`.`customers` WHERE `id` = ? LIMIT 1', params: [9] },
    ]);
  });

  it('omits LIMIT for SQLite and supports composite keys', () => {
    const t = table('shop', 'items', [col('items', 'order_id', 'int'), col('items', 'product_id', 'int'), col('items', 'qty', 'int')], ['order_id', 'product_id']);
    const [u] = buildEditStatements(t, [{ key: { order_id: 1, product_id: 2 }, changes: { qty: 3 } }], [], 'sqlite');
    expect(u).toEqual({ sql: 'UPDATE `shop`.`items` SET `qty` = ? WHERE `order_id` = ? AND `product_id` = ?', params: [3, 1, 2] });
  });

  it('refuses tables without primary key, views, partial keys and unknown columns', () => {
    const noPk = table('a', 'logs', [col('logs', 'msg')], []);
    expect(() => buildEditStatements(noPk, [{ key: { msg: 'x' }, changes: { msg: 'y' } }], [], 'mysql')).toThrow(/primary key/);
    const view = table('a', 'v', [col('v', 'id', 'int')], ['id'], 'view');
    expect(() => buildEditStatements(view, [], [{ id: 1 }], 'mysql')).toThrow(/Views/);
    expect(() => buildEditStatements(customers, [{ key: {}, changes: { status: 'x' } }], [], 'mysql')).toThrow(/exactly the primary key/);
    expect(() => buildEditStatements(customers, [{ key: { id: 1 }, changes: { nope: 1 } }], [], 'mysql')).toThrow(/Unknown column/);
    expect(() => buildEditStatements(customers, [], [{ id: null }], 'mysql')).toThrow(/NULL/);
  });

  it('skips updates without changes', () => {
    expect(buildEditStatements(customers, [{ key: { id: 1 }, changes: {} }], [], 'mysql')).toEqual([]);
  });
});
