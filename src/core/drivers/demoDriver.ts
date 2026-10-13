import initSqlJs from 'sql.js';
import type { Database, SqlValue } from 'sql.js';
import type { CellValue, ColumnInfo, DatabaseInfo, DatabaseSchema, DemoDataset, IndexInfo, QueryResult, TableDetails, TableInfo } from '../../shared/model';
import { DeepDiveError } from '../errors';
import { classifyStatement } from '../sql/classify';
import type { Statement } from '../sql/edits';
import { quoteIdent } from '../sql/identifiers';
import type { DbDriver, MetadataHitWithoutConnection, QueryOptions } from './driver';
import { demoDataset } from './demoData';
import { applyCardinality, assembleTableDetails, deriveColumnKey, groupForeignKeyRows, groupIndexRows } from './metadata';
import { toCell } from './serialize';

type Row = Record<string, SqlValue>;

/**
 * A fully offline "server" backed by SQLite compiled to WebAssembly (sql.js). Each demo database is an
 * attached in-memory schema, so `db`.`table` names work exactly like on MySQL.
 */
export class DemoDriver implements DbDriver {
  readonly dialect = 'sqlite' as const;
  private db: Database | undefined;
  private databases: string[] = [];

  constructor(
    private readonly dataset: DemoDataset,
    private readonly wasmPath?: string,
  ) {}

  private requireDb(): Database {
    if (!this.db) throw new DeepDiveError('Not connected', 'NOT_CONNECTED');
    return this.db;
  }

  async connect(): Promise<string> {
    const SQL = await initSqlJs(this.wasmPath ? { locateFile: () => this.wasmPath! } : undefined);
    const db = new SQL.Database();
    const defs = demoDataset(this.dataset);
    for (const d of defs) {
      db.run(`ATTACH DATABASE ':memory:' AS ${quoteIdent(d.name)}`);
      db.run('BEGIN');
      for (const t of d.tables) {
        db.run(t.ddl.replace(/^CREATE TABLE (\w+)/, (_m, name: string) => `CREATE TABLE ${quoteIdent(d.name)}.${quoteIdent(name)}`));
        const rows = t.rows();
        if (rows.length === 0) continue;
        const placeholders = rows[0]!.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO ${quoteIdent(d.name)}.${quoteIdent(t.name)} VALUES (${placeholders})`);
        for (const row of rows) stmt.run(row as SqlValue[]);
        stmt.free();
      }
      db.run('COMMIT');
    }
    db.run('PRAGMA foreign_keys = ON');
    this.db = db;
    this.databases = defs.map((d) => d.name);
    const version = this.all('SELECT sqlite_version() AS v')[0]?.v;
    return `DeepDive demo server (SQLite ${String(version)} via sql.js)`;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }

  private all(sql: string, params: SqlValue[] = []): Row[] {
    const stmt = this.requireDb().prepare(sql);
    try {
      stmt.bind(params);
      const out: Row[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as Row);
      return out;
    } finally {
      stmt.free();
    }
  }

  private assertDatabase(database: string): void {
    if (!this.databases.includes(database)) throw new DeepDiveError(`Unknown database "${database}"`, 'NOT_FOUND');
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    return this.databases.map((name) => ({
      name,
      tableCount: Number(this.all(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'`)[0]?.n ?? 0),
      isSystem: false,
    }));
  }

  async listTables(database: string): Promise<TableInfo[]> {
    this.assertDatabase(database);
    const q = quoteIdent(database);
    return this.all(`SELECT name, type FROM ${q}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((r) => ({
      database,
      name: String(r.name),
      type: r.type === 'view' ? 'view' : 'table',
      engine: 'SQLite',
      rowEstimate: Number(this.all(`SELECT COUNT(*) AS n FROM ${q}.${quoteIdent(String(r.name))}`)[0]?.n ?? 0),
    }));
  }

  private loadColumns(database: string, table?: string): ColumnInfo[] {
    const rows = this.all(
      `SELECT m.name AS tbl, p.cid AS cid, p.name AS name, p.type AS type, p."notnull" AS nn, p.dflt_value AS dflt, p.pk AS pk
       FROM ${quoteIdent(database)}.sqlite_master m JOIN pragma_table_info(m.name, ?) p
       WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ${table ? 'AND m.name = ?' : ''}
       ORDER BY m.name, p.cid`,
      table ? [database, table] : [database],
    );
    const pkCount = new Map<string, number>();
    for (const r of rows) if (Number(r.pk) > 0) pkCount.set(String(r.tbl), (pkCount.get(String(r.tbl)) ?? 0) + 1);
    return rows.map((r) => {
      const type = String(r.type ?? '').toLowerCase();
      const isPk = Number(r.pk) > 0;
      const auto = isPk && type === 'integer' && pkCount.get(String(r.tbl)) === 1;
      return {
        table: String(r.tbl),
        name: String(r.name),
        ordinal: Number(r.cid) + 1,
        dataType: type.replace(/\(.*$/, '').trim() || 'blob',
        columnType: type || 'blob',
        nullable: Number(r.nn) === 0 && !isPk,
        defaultValue: r.dflt === null ? null : String(r.dflt).replace(/^'(.*)'$/, '$1'),
        key: isPk ? 'PRI' : '',
        isPrimaryKey: isPk,
        isAutoIncrement: auto,
        extra: auto ? 'auto_increment' : '',
        comment: '',
      };
    });
  }

  private loadIndexes(database: string, columns: ColumnInfo[], table?: string): IndexInfo[] {
    const rows = this.all(
      `SELECT m.name AS tbl, il.name AS name, il."unique" AS uniq, il.origin AS origin, ii.seqno AS seq, ii.name AS col
       FROM ${quoteIdent(database)}.sqlite_master m
       JOIN pragma_index_list(m.name, ?) il
       JOIN pragma_index_info(il.name, ?) ii
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ${table ? 'AND m.name = ?' : ''}`,
      table ? [database, database, table] : [database, database],
    );
    const grouped = groupIndexRows(
      rows.map((r) => ({
        table: String(r.tbl),
        name: r.origin === 'pk' ? 'PRIMARY' : String(r.name).startsWith('sqlite_autoindex') ? `${String(r.col)}_unique` : String(r.name),
        unique: Number(r.uniq) === 1,
        column: String(r.col),
        seq: Number(r.seq),
        type: 'BTREE',
      })),
    );
    // INTEGER PRIMARY KEY columns are the rowid and have no explicit index entry.
    const tables = new Set(columns.map((c) => c.table));
    for (const t of tables) {
      if (grouped.some((i) => i.table === t && i.primary)) continue;
      const pk = columns.filter((c) => c.table === t && c.isPrimaryKey).sort((a, b) => a.ordinal - b.ordinal);
      if (pk.length) grouped.push({ table: t, name: 'PRIMARY', unique: true, primary: true, columns: pk.map((c) => c.name), type: 'BTREE' });
    }
    return grouped;
  }

  private loadForeignKeys(database: string, indexes: IndexInfo[], columns: ColumnInfo[]) {
    const rows = this.all(
      `SELECT m.name AS tbl, f.id AS id, f.seq AS seq, f."table" AS ref_tbl, f."from" AS col, f."to" AS ref_col, f.on_update AS on_update, f.on_delete AS on_delete
       FROM ${quoteIdent(database)}.sqlite_master m JOIN pragma_foreign_key_list(m.name, ?) f
       WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq`,
      [database],
    );
    const fks = groupForeignKeyRows(
      rows.map((r) => {
        const refTable = String(r.ref_tbl);
        const refCol = r.ref_col === null ? (columns.find((c) => c.table === refTable && c.isPrimaryKey)?.name ?? 'id') : String(r.ref_col);
        return {
          name: `fk_${String(r.tbl)}_${String(r.id)}`,
          database,
          table: String(r.tbl),
          column: String(r.col),
          refDatabase: database,
          refTable,
          refColumn: refCol,
          ordinal: Number(r.seq),
          onUpdate: String(r.on_update),
          onDelete: String(r.on_delete),
        };
      }),
    ).map((fk) => ({ ...fk, name: `fk_${fk.table}_${fk.columns.join('_')}` }));
    return applyCardinality(fks, (_db, t) => indexes.filter((i) => i.table === t));
  }

  async loadDatabaseSchema(database: string): Promise<DatabaseSchema> {
    this.assertDatabase(database);
    const tables = await this.listTables(database);
    const columns = this.loadColumns(database);
    const indexes = this.loadIndexes(database, columns);
    for (const c of columns) c.key = deriveColumnKey(c.name, indexes.filter((i) => i.table === c.table));
    return { database, tables, columns, indexes, foreignKeys: this.loadForeignKeys(database, indexes, columns) };
  }

  async loadTableDetails(database: string, table: string): Promise<TableDetails> {
    this.assertDatabase(database);
    const meta = this.all(`SELECT name, type FROM ${quoteIdent(database)}.sqlite_master WHERE type IN ('table','view') AND name = ?`, [table])[0];
    if (!meta) throw new DeepDiveError(`Table ${database}.${table} was not found`, 'NOT_FOUND');
    // FKs in SQLite are declared per table, so incoming references require the whole schema (cheap in memory).
    const schema = await this.loadDatabaseSchema(database);
    const info = schema.tables.find((t) => t.name === table)!;
    return assembleTableDetails(info, schema.columns, schema.indexes, schema.foreignKeys);
  }

  async searchMetadata(term: string, limit: number): Promise<MetadataHitWithoutConnection[]> {
    const t = term.toLowerCase();
    const hits: MetadataHitWithoutConnection[] = [];
    for (const database of this.databases) {
      if (database.toLowerCase().includes(t)) hits.push({ kind: 'database', database });
    }
    for (const database of this.databases) {
      const rows = this.all(
        `SELECT m.name AS tbl, m.type AS type, p.name AS col, p.type AS ctype FROM ${quoteIdent(database)}.sqlite_master m
         JOIN pragma_table_info(m.name, ?) p WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`,
        [database],
      );
      const seenTables = new Set<string>();
      for (const r of rows) {
        const tbl = String(r.tbl);
        if (!seenTables.has(tbl)) {
          seenTables.add(tbl);
          if (tbl.toLowerCase().includes(t)) hits.push({ kind: 'table', database, table: tbl, detail: String(r.type) });
        }
        if (String(r.col).toLowerCase().includes(t)) hits.push({ kind: 'column', database, table: tbl, column: String(r.col), detail: String(r.ctype).toLowerCase() });
      }
    }
    const order = { database: 0, table: 1, column: 2 } as const;
    // Keep the per-kind limit semantics of the MySQL driver.
    const counts = { database: 0, table: 0, column: 0 };
    return hits.sort((a, b) => order[a.kind] - order[b.kind]).filter((h) => ++counts[h.kind] <= limit);
  }

  private emulate(sql: string): QueryResult | undefined {
    const c = classifyStatement(sql);
    const started = Date.now();
    if (c.keyword === 'USE') return { kind: 'ok', columns: [], rows: [], truncated: false, affectedRows: 0, durationMs: 0 };
    if (/^\s*SHOW\s+DATABASES\s*;?\s*$/i.test(sql)) {
      return { kind: 'rows', columns: [{ name: 'Database' }], rows: this.databases.map((d) => [d]), truncated: false, durationMs: Date.now() - started };
    }
    const m = /^\s*SHOW\s+TABLES(?:\s+(?:FROM|IN)\s+`?([\w$]+)`?)?\s*;?\s*$/i.exec(sql);
    if (m) {
      const dbs = m[1] ? [m[1]] : this.databases;
      const rows: CellValue[][] = [];
      for (const d of dbs) {
        this.assertDatabase(d);
        for (const r of this.all(`SELECT name FROM ${quoteIdent(d)}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)) rows.push(m[1] ? [String(r.name)] : [`${d}.${String(r.name)}`]);
      }
      return { kind: 'rows', columns: [{ name: 'Tables' }], rows, truncated: false, durationMs: Date.now() - started };
    }
    return undefined;
  }

  async query(sql: string, params: readonly CellValue[], options: QueryOptions): Promise<QueryResult> {
    const db = this.requireDb();
    if (options.signal?.aborted) throw new DeepDiveError('Query cancelled', 'CANCELLED');
    const emulated = this.emulate(sql);
    if (emulated) return emulated;
    const started = Date.now();
    if (options.readOnly) db.run('PRAGMA query_only = 1');
    let stmt: ReturnType<Database['prepare']> | undefined;
    try {
      stmt = db.prepare(sql);
      stmt.bind(params as SqlValue[]);
      const names = stmt.getColumnNames();
      const rows: CellValue[][] = [];
      let truncated = false;
      while (stmt.step()) {
        if (rows.length >= options.maxRows) {
          truncated = true;
          break;
        }
        rows.push(stmt.get().map(toCell));
        if (rows.length % 2000 === 0) {
          await new Promise((r) => setImmediate(r));
          if (options.signal?.aborted) throw new DeepDiveError('Query cancelled', 'CANCELLED');
          if (Date.now() - started > options.timeoutMs) throw new DeepDiveError('Query exceeded the timeout and was cancelled', 'TIMEOUT');
        }
      }
      if (names.length === 0) {
        return { kind: 'ok', columns: [], rows: [], truncated: false, affectedRows: db.getRowsModified(), durationMs: Date.now() - started };
      }
      return { kind: 'rows', columns: names.map((name) => ({ name })), rows, truncated, durationMs: Date.now() - started };
    } catch (err) {
      if (err instanceof DeepDiveError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/readonly|query_only/i.test(msg)) throw new DeepDiveError('The statement tried to write on a read-only query and was rejected.', 'READ_ONLY');
      throw new DeepDiveError(msg, 'DB_ERROR');
    } finally {
      stmt?.free();
      if (options.readOnly) db.run('PRAGMA query_only = 0');
    }
  }

  async transaction(statements: readonly Statement[], options: QueryOptions, verify?: (index: number, affectedRows: number) => void): Promise<number[]> {
    const db = this.requireDb();
    db.run('BEGIN');
    const affected: number[] = [];
    try {
      for (const [i, st] of statements.entries()) {
        if (options.signal?.aborted) throw new DeepDiveError('Cancelled before commit', 'CANCELLED');
        db.run(st.sql, st.params as SqlValue[]);
        const n = db.getRowsModified();
        affected.push(n);
        verify?.(i, n);
      }
      db.run('COMMIT');
      return affected;
    } catch (err) {
      try {
        db.run('ROLLBACK');
      } catch {
        // transaction already closed
      }
      if (err instanceof DeepDiveError) throw err;
      throw new DeepDiveError(err instanceof Error ? err.message : String(err), 'DB_ERROR');
    }
  }
}
