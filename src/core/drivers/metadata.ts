import type { Cardinality, ColumnInfo, ForeignKeyInfo, IndexInfo, TableDetails, TableInfo } from '../../shared/model';

/** A foreign key is one-to-one only if a unique index covers a subset of its columns. Otherwise many-to-one. */
export function deriveCardinality(fkColumns: readonly string[], childIndexes: readonly IndexInfo[]): Cardinality {
  const fk = new Set(fkColumns);
  const unique = childIndexes.some((i) => i.unique && i.columns.length > 0 && i.columns.every((c) => fk.has(c)));
  return unique ? 'one-to-one' : 'many-to-one';
}

export function primaryKeyOf(columns: readonly ColumnInfo[], indexes: readonly IndexInfo[]): string[] {
  const primary = indexes.find((i) => i.primary);
  if (primary) return [...primary.columns];
  return columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
}

export function assembleTableDetails(
  table: TableInfo,
  allColumns: readonly ColumnInfo[],
  allIndexes: readonly IndexInfo[],
  allForeignKeys: readonly ForeignKeyInfo[],
): TableDetails {
  const columns = allColumns.filter((c) => c.table === table.name).sort((a, b) => a.ordinal - b.ordinal);
  const indexes = allIndexes.filter((i) => i.table === table.name);
  return {
    table,
    columns,
    indexes,
    primaryKey: primaryKeyOf(columns, indexes),
    foreignKeys: allForeignKeys.filter((f) => f.database === table.database && f.table === table.name),
    referencedBy: allForeignKeys.filter((f) => f.referencedDatabase === table.database && f.referencedTable === table.name),
  };
}

/** Groups flat index rows (one row per index column) into IndexInfo objects. */
export function groupIndexRows(
  rows: readonly { table: string; name: string; unique: boolean; column: string; seq: number; type: string }[],
): IndexInfo[] {
  const map = new Map<string, IndexInfo & { seqs: number[] }>();
  for (const r of rows) {
    const key = `${r.table}\u0000${r.name}`;
    let idx = map.get(key);
    if (!idx) {
      idx = { table: r.table, name: r.name, unique: r.unique, primary: r.name === 'PRIMARY', columns: [], type: r.type, seqs: [] };
      map.set(key, idx);
    }
    idx.columns.push(r.column);
    idx.seqs.push(r.seq);
  }
  return [...map.values()].map(({ seqs, ...idx }) => {
    const order = seqs.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
    return { ...idx, columns: order.map(([, i]) => idx.columns[i]!) };
  });
}

/** Groups flat FK rows (one row per column pair) into ForeignKeyInfo objects (cardinality filled later). */
export function groupForeignKeyRows(
  rows: readonly {
    name: string;
    database: string;
    table: string;
    column: string;
    refDatabase: string;
    refTable: string;
    refColumn: string;
    ordinal: number;
    onUpdate: string;
    onDelete: string;
  }[],
): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo & { ords: number[]; refCols: string[] }>();
  for (const r of rows) {
    const key = `${r.database}\u0000${r.table}\u0000${r.name}`;
    let fk = map.get(key);
    if (!fk) {
      fk = {
        name: r.name,
        database: r.database,
        table: r.table,
        columns: [],
        referencedDatabase: r.refDatabase,
        referencedTable: r.refTable,
        referencedColumns: [],
        onUpdate: r.onUpdate,
        onDelete: r.onDelete,
        cardinality: 'many-to-one',
        ords: [],
        refCols: [],
      };
      map.set(key, fk);
    }
    fk.columns.push(r.column);
    fk.refCols.push(r.refColumn);
    fk.ords.push(r.ordinal);
  }
  return [...map.values()].map(({ ords, refCols, ...fk }) => {
    const order = ords.map((o, i) => [o, i] as const).sort((a, b) => a[0] - b[0]);
    return { ...fk, columns: order.map(([, i]) => fk.columns[i]!), referencedColumns: order.map(([, i]) => refCols[i]!) };
  });
}

export function applyCardinality(fks: ForeignKeyInfo[], indexesFor: (database: string, table: string) => readonly IndexInfo[]): ForeignKeyInfo[] {
  return fks.map((fk) => ({ ...fk, cardinality: deriveCardinality(fk.columns, indexesFor(fk.database, fk.table)) }));
}

/** Derives MySQL-style COLUMN_KEY values from indexes (used by engines that do not report it). */
export function deriveColumnKey(column: string, indexes: readonly IndexInfo[]): ColumnInfo['key'] {
  if (indexes.some((i) => i.primary && i.columns.includes(column))) return 'PRI';
  if (indexes.some((i) => i.unique && i.columns.length === 1 && i.columns[0] === column)) return 'UNI';
  if (indexes.some((i) => i.columns[0] === column)) return 'MUL';
  return '';
}
