import type { ColumnInfo, TableDetails } from '../../src/shared/model';

export function col(table: string, name: string, dataType = 'varchar', extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    table,
    name,
    ordinal: 1,
    dataType,
    columnType: dataType,
    nullable: true,
    defaultValue: null,
    key: '',
    isPrimaryKey: false,
    isAutoIncrement: false,
    extra: '',
    comment: '',
    ...extra,
  };
}

export function table(database: string, name: string, columns: ColumnInfo[], primaryKey: string[] = ['id'], type: 'table' | 'view' = 'table'): TableDetails {
  return {
    table: { database, name, type },
    columns: columns.map((c, i) => ({ ...c, table: name, ordinal: i + 1, isPrimaryKey: primaryKey.includes(c.name) })),
    indexes: primaryKey.length ? [{ table: name, name: 'PRIMARY', unique: true, primary: true, columns: primaryKey, type: 'BTREE' }] : [],
    primaryKey,
    foreignKeys: [],
    referencedBy: [],
  };
}

export const customers = table('shop', 'customers', [
  col('customers', 'id', 'int'),
  col('customers', 'email'),
  col('customers', 'status'),
  col('customers', 'is_vip', 'tinyint'),
  col('customers', 'created_at', 'datetime'),
]);

export const orders = table('shop', 'orders', [col('orders', 'id', 'int'), col('orders', 'customer_id', 'int'), col('orders', 'total', 'decimal'), col('orders', 'status')]);

export const lookup = (database: string, name: string): TableDetails => {
  const all = [customers, orders];
  const t = all.find((x) => x.table.database === database && x.table.name === name);
  if (!t) throw new Error(`no table ${database}.${name}`);
  return t;
};
