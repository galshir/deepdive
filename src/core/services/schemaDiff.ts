// Pure schema comparison: two DatabaseSchema snapshots in, a structured diff out. No I/O, so the
// rules (what counts as a difference, how objects are matched) are unit-testable in isolation.
import type {
  ColumnInfo,
  DatabaseSchema,
  DiffStatus,
  FieldDiff,
  ForeignKeyInfo,
  IndexInfo,
  ObjectDiff,
  SchemaCompareOptions,
  SchemaDiffSummary,
  TableDiff,
  TableInfo,
} from '../../shared/model';

export const DEFAULT_COMPARE_OPTIONS: SchemaCompareOptions = { ignoreColumnOrder: true, ignoreComments: true, normalizeTypes: false, ignoreCase: false };

const INT_WIDTH = /^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/;

/** Lower-cases a column type; with `normalize`, drops integer display widths (MySQL 8 hides them) except tinyint(1). */
export function normalizeColumnType(type: string, normalize: boolean): string {
  const t = type.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalize && !t.startsWith('tinyint(1)') ? t.replace(INT_WIDTH, '$1') : t;
}

/** With `normalize`, makes defaults reported differently by MySQL 5.7, 8 and MariaDB comparable. */
export function normalizeDefault(value: string | null, normalize: boolean): string | null {
  if (value === null || !normalize) return value;
  let v = value.trim();
  if (/^'.*'$/s.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
  if (/^null$/i.test(v)) return null;
  if (/^current_timestamp(\(\))?$/i.test(v)) return 'CURRENT_TIMESTAMP';
  return v;
}

function normalizeExtra(extra: string, normalize: boolean): string {
  let e = extra.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalize) e = e.replace(/default_generated\s*/g, '').replace(/current_timestamp\(\)/g, 'current_timestamp').trim();
  return e;
}

export function describeColumn(c: ColumnInfo): string {
  return [c.columnType, c.nullable ? 'NULL' : 'NOT NULL', c.defaultValue !== null ? `DEFAULT ${c.defaultValue}` : '', c.extra, c.comment ? `COMMENT '${c.comment}'` : '']
    .filter(Boolean)
    .join(' ');
}

const indexKind = (i: IndexInfo) => (i.primary ? 'PRIMARY KEY' : i.unique ? 'UNIQUE' : 'INDEX');

export function describeIndex(i: IndexInfo): string {
  return `${indexKind(i)} (${i.columns.join(', ')})${i.type && i.type.toUpperCase() !== 'BTREE' ? ` ${i.type}` : ''}`;
}

/** References into the table's own database are shown unqualified, so equal schemas in different databases compare equal. */
const refTable = (fk: ForeignKeyInfo) => (fk.referencedDatabase && fk.referencedDatabase !== fk.database ? `${fk.referencedDatabase}.${fk.referencedTable}` : fk.referencedTable);

export function describeForeignKey(fk: ForeignKeyInfo): string {
  return `(${fk.columns.join(', ')}) → ${refTable(fk)} (${fk.referencedColumns.join(', ')}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
}

class Differ {
  constructor(private readonly opts: SchemaCompareOptions) {}

  key = (name: string) => (this.opts.ignoreCase ? name.toLowerCase() : name);

  private groupBy<T extends { table: string }>(items: T[]): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const it of items) {
      const k = this.key(it.table);
      const list = m.get(k);
      if (list) list.push(it);
      else m.set(k, [it]);
    }
    return m;
  }

  /** Pairs items by name; leftovers on both sides may still be paired by `signature` (renamed objects). */
  private pair<T>(source: T[], target: T[], name: (x: T) => string, signature?: (x: T) => string) {
    const byName = new Map(target.map((t) => [this.key(name(t)), t]));
    const pairs: { s?: T; t?: T; renamed?: boolean }[] = [];
    const usedTargets = new Set<T>();
    const leftover: T[] = [];
    for (const s of source) {
      const t = byName.get(this.key(name(s)));
      if (t) {
        pairs.push({ s, t });
        usedTargets.add(t);
      } else {
        leftover.push(s);
      }
    }
    const unpairedTargets = target.filter((t) => !usedTargets.has(t));
    for (const s of leftover) {
      const sig = signature?.(s);
      const t = sig !== undefined ? unpairedTargets.find((x) => !usedTargets.has(x) && signature!(x) === sig) : undefined;
      if (t) {
        usedTargets.add(t);
        pairs.push({ s, t, renamed: true });
      } else {
        pairs.push({ s });
      }
    }
    for (const t of unpairedTargets) if (!usedTargets.has(t)) pairs.push({ t });
    return pairs;
  }

  private field(changes: FieldDiff[], field: string, s: string | null, t: string | null, sNorm: unknown = s, tNorm: unknown = t) {
    if (sNorm !== tNorm) changes.push({ field, source: s, target: t });
  }

  columns(source: ColumnInfo[], target: ColumnInfo[]): ObjectDiff[] {
    const o = this.opts;
    const sorted = (cols: ColumnInfo[]) => [...cols].sort((a, b) => a.ordinal - b.ordinal);
    const src = sorted(source);
    const tgt = sorted(target);
    const prevName = (cols: ColumnInfo[], c: ColumnInfo) => {
      const i = cols.indexOf(c);
      return i <= 0 ? 'FIRST' : `AFTER ${cols[i - 1]!.name}`;
    };
    return this.pair(src, tgt, (c) => c.name).map(({ s, t }): ObjectDiff => {
      if (s && !t) return { kind: 'column', name: s.name, status: 'only_source', changes: [], source: describeColumn(s) };
      if (t && !s) return { kind: 'column', name: t.name, status: 'only_target', changes: [], target: describeColumn(t) };
      const a = s!;
      const b = t!;
      const changes: FieldDiff[] = [];
      this.field(changes, 'type', a.columnType, b.columnType, normalizeColumnType(a.columnType, o.normalizeTypes), normalizeColumnType(b.columnType, o.normalizeTypes));
      this.field(changes, 'nullable', a.nullable ? 'NULL' : 'NOT NULL', b.nullable ? 'NULL' : 'NOT NULL');
      this.field(changes, 'default', a.defaultValue, b.defaultValue, normalizeDefault(a.defaultValue, o.normalizeTypes), normalizeDefault(b.defaultValue, o.normalizeTypes));
      this.field(changes, 'extra', a.extra || null, b.extra || null, normalizeExtra(a.extra, o.normalizeTypes), normalizeExtra(b.extra, o.normalizeTypes));
      if (!o.ignoreComments) this.field(changes, 'comment', a.comment || null, b.comment || null);
      if (!o.ignoreColumnOrder) {
        const pa = prevName(src, a);
        const pb = prevName(tgt, b);
        this.field(changes, 'position', pa, pb, this.key(pa), this.key(pb));
      }
      return { kind: 'column', name: a.name, status: changes.length ? 'changed' : 'same', changes, source: describeColumn(a), target: describeColumn(b) };
    });
  }

  indexes(source: IndexInfo[], target: IndexInfo[]): ObjectDiff[] {
    const cols = (i: IndexInfo) => i.columns.map(this.key).join(',');
    const signature = (i: IndexInfo) => [indexKind(i), cols(i), (i.type || 'BTREE').toUpperCase()].join('|');
    return this.pair(source, target, (i) => i.name, signature).map(({ s, t, renamed }): ObjectDiff => {
      if (s && !t) return { kind: 'index', name: s.name, status: 'only_source', changes: [], source: describeIndex(s) };
      if (t && !s) return { kind: 'index', name: t.name, status: 'only_target', changes: [], target: describeIndex(t) };
      const a = s!;
      const b = t!;
      const changes: FieldDiff[] = [];
      if (renamed) changes.push({ field: 'name', source: a.name, target: b.name });
      this.field(changes, 'kind', indexKind(a), indexKind(b));
      this.field(changes, 'columns', a.columns.join(', '), b.columns.join(', '), cols(a), cols(b));
      this.field(changes, 'type', a.type || null, b.type || null, (a.type || 'BTREE').toUpperCase(), (b.type || 'BTREE').toUpperCase());
      return { kind: 'index', name: a.name, targetName: renamed ? b.name : undefined, status: changes.length ? 'changed' : 'same', changes, source: describeIndex(a), target: describeIndex(b) };
    });
  }

  foreignKeys(source: ForeignKeyInfo[], target: ForeignKeyInfo[]): ObjectDiff[] {
    const def = (fk: ForeignKeyInfo) =>
      [fk.columns.map(this.key).join(','), this.key(refTable(fk)), fk.referencedColumns.map(this.key).join(','), fk.onDelete.toUpperCase(), fk.onUpdate.toUpperCase()].join('|');
    return this.pair(source, target, (fk) => fk.name, def).map(({ s, t, renamed }): ObjectDiff => {
      if (s && !t) return { kind: 'foreignKey', name: s.name, status: 'only_source', changes: [], source: describeForeignKey(s) };
      if (t && !s) return { kind: 'foreignKey', name: t.name, status: 'only_target', changes: [], target: describeForeignKey(t) };
      const a = s!;
      const b = t!;
      const changes: FieldDiff[] = [];
      if (renamed) changes.push({ field: 'name', source: a.name, target: b.name });
      this.field(changes, 'columns', a.columns.join(', '), b.columns.join(', '), a.columns.map(this.key).join(','), b.columns.map(this.key).join(','));
      this.field(changes, 'references', `${refTable(a)} (${a.referencedColumns.join(', ')})`, `${refTable(b)} (${b.referencedColumns.join(', ')})`, this.key(`${refTable(a)}|${a.referencedColumns.join(',')}`), this.key(`${refTable(b)}|${b.referencedColumns.join(',')}`));
      this.field(changes, 'on delete', a.onDelete, b.onDelete, a.onDelete.toUpperCase(), b.onDelete.toUpperCase());
      this.field(changes, 'on update', a.onUpdate, b.onUpdate, a.onUpdate.toUpperCase(), b.onUpdate.toUpperCase());
      return { kind: 'foreignKey', name: a.name, targetName: renamed ? b.name : undefined, status: changes.length ? 'changed' : 'same', changes, source: describeForeignKey(a), target: describeForeignKey(b) };
    });
  }

  tables(src: DatabaseSchema, tgt: DatabaseSchema): TableDiff[] {
    const o = this.opts;
    const [sc, tc] = [this.groupBy(src.columns), this.groupBy(tgt.columns)];
    const [si, ti] = [this.groupBy(src.indexes), this.groupBy(tgt.indexes)];
    const [sf, tf] = [this.groupBy(src.foreignKeys), this.groupBy(tgt.foreignKeys)];
    const out = this.pair(src.tables, tgt.tables, (t) => t.name).map(({ s, t }): TableDiff => {
      const info = (s ?? t)!;
      const k = this.key(info.name);
      const columns = this.columns(s ? (sc.get(k) ?? []) : [], t ? (tc.get(k) ?? []) : []);
      const indexes = this.indexes(s ? (si.get(k) ?? []) : [], t ? (ti.get(k) ?? []) : []);
      const foreignKeys = this.foreignKeys(s ? (sf.get(k) ?? []) : [], t ? (tf.get(k) ?? []) : []);
      if (!s || !t) return { name: info.name, type: info.type, status: s ? 'only_source' : 'only_target', changes: [], columns, indexes, foreignKeys };
      const changes: FieldDiff[] = [];
      const engine = (x: TableInfo) => x.engine?.toLowerCase() ?? null;
      this.field(changes, 'type', s.type, t.type);
      this.field(changes, 'engine', s.engine ?? null, t.engine ?? null, engine(s), engine(t));
      if (!o.ignoreComments) this.field(changes, 'comment', s.comment || null, t.comment || null);
      const childChanged = [...columns, ...indexes, ...foreignKeys].some((d) => d.status !== 'same');
      return {
        name: s.name,
        targetName: t.name !== s.name ? t.name : undefined,
        type: s.type,
        status: changes.length || childChanged ? 'changed' : 'same',
        changes,
        columns,
        indexes,
        foreignKeys,
      };
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function diffSchemas(source: DatabaseSchema, target: DatabaseSchema, options: SchemaCompareOptions): TableDiff[] {
  return new Differ(options).tables(source, target);
}

export function summarizeDiff(tables: readonly TableDiff[]): SchemaDiffSummary {
  const summary: SchemaDiffSummary = { tables: { same: 0, only_source: 0, only_target: 0, changed: 0 }, objects: { only_source: 0, only_target: 0, changed: 0 } };
  for (const t of tables) {
    summary.tables[t.status]++;
    if (t.status !== 'changed') continue;
    for (const d of [...t.columns, ...t.indexes, ...t.foreignKeys]) if (d.status !== 'same') summary.objects[d.status]++;
  }
  return summary;
}

export const isIdentical = (s: SchemaDiffSummary) => s.tables.only_source + s.tables.only_target + s.tables.changed === 0;

/** Status of a whole schema pair, as shown in a server-level comparison. */
export const schemaStatus = (s: SchemaDiffSummary): DiffStatus => (isIdentical(s) ? 'same' : 'changed');
