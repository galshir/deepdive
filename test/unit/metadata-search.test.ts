import { describe, expect, it } from 'vitest';
import { deriveCardinality, deriveColumnKey, groupForeignKeyRows, groupIndexRows } from '../../src/core/drivers/metadata';
import { toCell } from '../../src/core/drivers/serialize';
import { buildDataSearchQuery } from '../../src/core/sql/search';
import { customers } from '../helpers/fixtures';

describe('metadata helpers', () => {
  it('derives cardinality only from unique indexes', () => {
    const uniq = [{ table: 'p', name: 'u', unique: true, primary: false, columns: ['order_id'], type: 'BTREE' }];
    expect(deriveCardinality(['order_id'], uniq)).toBe('one-to-one');
    expect(deriveCardinality(['order_id'], [{ ...uniq[0]!, unique: false }])).toBe('many-to-one');
    expect(deriveCardinality(['a'], [{ ...uniq[0]!, columns: ['a', 'b'] }])).toBe('many-to-one');
  });

  it('groups composite indexes and foreign keys in ordinal order', () => {
    const idx = groupIndexRows([
      { table: 't', name: 'ix', unique: false, column: 'b', seq: 2, type: 'BTREE' },
      { table: 't', name: 'ix', unique: false, column: 'a', seq: 1, type: 'BTREE' },
    ]);
    expect(idx).toEqual([{ table: 't', name: 'ix', unique: false, primary: false, columns: ['a', 'b'], type: 'BTREE' }]);
    const fks = groupForeignKeyRows([
      { name: 'fk', database: 'd', table: 't', column: 'y', refDatabase: 'd', refTable: 'p', refColumn: 'py', ordinal: 2, onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
      { name: 'fk', database: 'd', table: 't', column: 'x', refDatabase: 'd', refTable: 'p', refColumn: 'px', ordinal: 1, onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
    ]);
    expect(fks[0]!.columns).toEqual(['x', 'y']);
    expect(fks[0]!.referencedColumns).toEqual(['px', 'py']);
    expect(deriveColumnKey('a', idx)).toBe('MUL');
    expect(deriveColumnKey('b', idx)).toBe('');
  });

  it('serializes driver values safely', () => {
    expect(toCell(undefined)).toBeNull();
    expect(toCell(10n)).toBe('10');
    expect(toCell(Buffer.from([1, 255]))).toBe('0x01FF');
    expect(toCell(Buffer.alloc(100))).toBe('(binary 100 bytes)');
    expect(toCell({ a: 1 })).toBe('{"a":1}');
    expect(toCell(Number.NaN)).toBe('NaN');
  });
});

describe('buildDataSearchQuery', () => {
  it('searches text columns with escaped LIKE and is bounded', () => {
    const q = buildDataSearchQuery(customers, '100%', 'contains', 25)!;
    expect(q.searchedColumns).toEqual(['email', 'status']);
    expect(q.sql).toBe("SELECT `id`, `email`, `status`, `is_vip`, `created_at` FROM `shop`.`customers` WHERE (`email` LIKE ? ESCAPE '!') OR (`status` LIKE ? ESCAPE '!') LIMIT ?");
    expect(q.params).toEqual(['%100!%%', '%100!%%', 25]);
  });

  it('includes numeric columns by equality for numeric terms', () => {
    const q = buildDataSearchQuery(customers, '42', 'equals', 5)!;
    expect(q.searchedColumns).toEqual(['id', 'email', 'status', 'is_vip']);
    expect(q.params).toEqual([42, '42', '42', 42, 5]);
  });

  it('validates explicit columns and returns null when nothing is searchable', () => {
    expect(() => buildDataSearchQuery(customers, 'x', 'contains', 5, ['ghost'])).toThrow(/Unknown column/);
    expect(buildDataSearchQuery(customers, 'x', 'contains', 5, ['id'])).toBeNull();
    expect(buildDataSearchQuery(customers, '2024', 'contains', 5, ['created_at'])!.sql).toContain('CAST(`created_at` AS CHAR)');
  });
});
