import { readFileSync } from 'node:fs';
import * as mysql from 'mysql2';
import type { FieldPacket, Pool, PoolConnection, PoolOptions, QueryError, ResultSetHeader } from 'mysql2';
import type { CellValue, ColumnInfo, ConnectionConfig, DatabaseInfo, DatabaseSchema, IndexInfo, QueryResult, ResultColumn, TableDetails, TableInfo } from '../../shared/model';
import { DeepDiveError } from '../errors';
import type { Statement } from '../sql/edits';
import { escapeLike, quoteIdent } from '../sql/identifiers';
import type { DbDriver, MetadataHitWithoutConnection, QueryOptions } from './driver';
import { SYSTEM_DATABASES } from './driver';
import { applyCardinality, assembleTableDetails, deriveCardinality, groupForeignKeyRows, groupIndexRows } from './metadata';
import { toCell } from './serialize';

type Row = Record<string, unknown>;

const METADATA_TIMEOUT_MS = 60_000;

/** Maps low-level driver errors to messages a user can act on. Never includes credentials. */
export function friendlyMysqlError(err: unknown, config: Pick<ConnectionConfig, 'host' | 'port' | 'user'>): DeepDiveError {
  if (err instanceof DeepDiveError) return err;
  const e = err as Partial<QueryError> & { message?: string; sqlMessage?: string };
  const code = e.code ?? '';
  const where = `${config.host}:${config.port}`;
  switch (code) {
    case 'ECONNREFUSED':
      return new DeepDiveError(`Connection refused by ${where}. Is MySQL running and reachable?`, 'CONNECTION');
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new DeepDiveError(`Host "${config.host}" could not be resolved.`, 'CONNECTION');
    case 'ETIMEDOUT':
      return new DeepDiveError(`Timed out connecting to ${where}.`, 'TIMEOUT');
    case 'ER_ACCESS_DENIED_ERROR':
      return new DeepDiveError(`Access denied for user "${config.user}". Check the username and password.`, 'CONNECTION');
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR':
    case 'ER_SPECIFIC_ACCESS_DENIED_ERROR':
      return new DeepDiveError(`Permission denied: ${e.sqlMessage ?? e.message ?? code}`, 'DB_ERROR');
    case 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION':
      return new DeepDiveError('The statement tried to write inside a read-only transaction and was rejected by MySQL.', 'READ_ONLY');
    case 'ER_BAD_DB_ERROR':
      return new DeepDiveError(e.sqlMessage ?? 'Unknown database', 'NOT_FOUND');
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ECONNRESET':
    case 'EPIPE':
      return new DeepDiveError('The connection to MySQL was lost. It will be re-established on the next request.', 'CONNECTION');
    case 'HANDSHAKE_SSL_ERROR':
    case 'HANDSHAKE_NO_SSL_SUPPORT':
      return new DeepDiveError(`TLS handshake failed: ${e.message ?? code}`, 'CONNECTION');
    default:
      if (e.sqlMessage) return new DeepDiveError(`${code ? `${code}: ` : ''}${e.sqlMessage}`, 'DB_ERROR');
      if (/certificate|self[- ]signed|SSL|TLS/i.test(e.message ?? '')) return new DeepDiveError(`TLS error: ${e.message}`, 'CONNECTION');
      return new DeepDiveError(e.message ?? 'Unknown MySQL error', code.startsWith('ER_') ? 'DB_ERROR' : 'CONNECTION');
  }
}

export interface MysqlDriverOptions {
  poolSize: number;
}

export function buildPoolOptions(config: ConnectionConfig, password: string | undefined, options: MysqlDriverOptions): PoolOptions {
  const pool: PoolOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: password ?? undefined,
    database: config.database || undefined,
    connectionLimit: options.poolSize,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: config.connectTimeoutMs,
    enableKeepAlive: true,
    charset: 'utf8mb4',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,
    multipleStatements: false,
    // Never let a server request files from this machine via LOAD DATA LOCAL INFILE.
    flags: ['-LOCAL_FILES'],
  };
  if (config.tls.mode !== 'disabled') {
    const read = (p?: string) => (p ? readFileSync(p) : undefined);
    pool.ssl = {
      rejectUnauthorized: config.tls.mode === 'verify',
      ca: read(config.tls.caPath),
      cert: read(config.tls.certPath),
      key: read(config.tls.keyPath),
    };
  }
  return pool;
}

const num = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export class MysqlDriver implements DbDriver {
  readonly dialect = 'mysql' as const;
  private pool: Pool | undefined;
  private readonly poolOptions: PoolOptions;
  /** Tracks which default database each pooled connection currently has. */
  private readonly currentDb = new WeakMap<PoolConnection, string | null>();

  constructor(
    private readonly config: ConnectionConfig,
    password: string | undefined,
    options: MysqlDriverOptions,
  ) {
    this.poolOptions = buildPoolOptions(config, password, options);
  }

  private wrap(err: unknown): DeepDiveError {
    return friendlyMysqlError(err, this.config);
  }

  private requirePool(): Pool {
    if (!this.pool) throw new DeepDiveError('Not connected', 'NOT_CONNECTED');
    return this.pool;
  }

  async connect(): Promise<string> {
    const pool = mysql.createPool(this.poolOptions);
    // Swallow pool-level errors (e.g. idle connections dropped by the server); they surface on the next query.
    pool.on('connection', (conn) => conn.on('error', () => undefined));
    try {
      const [rows] = await pool.promise().query({ sql: 'SELECT VERSION() AS version', timeout: this.config.connectTimeoutMs });
      this.pool = pool;
      return str((rows as Row[])[0]?.version);
    } catch (err) {
      await pool.promise().end().catch(() => undefined);
      throw this.wrap(err);
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    if (pool) await pool.promise().end().catch(() => undefined);
  }

  private async meta(sql: string, params: unknown[] = []): Promise<Row[]> {
    try {
      const [rows] = await this.requirePool().promise().query({ sql, values: params, timeout: METADATA_TIMEOUT_MS });
      return rows as Row[];
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async listDatabases(): Promise<DatabaseInfo[]> {
    const rows = await this.meta(
      `SELECT s.SCHEMA_NAME AS name, COUNT(t.TABLE_NAME) AS table_count, SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS size_bytes
       FROM information_schema.SCHEMATA s
       LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
       GROUP BY s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME`,
    );
    return rows.map((r) => ({
      name: str(r.name),
      tableCount: num(r.table_count),
      sizeBytes: num(r.size_bytes),
      isSystem: SYSTEM_DATABASES.has(str(r.name).toLowerCase()),
    }));
  }

  private tableRows(rows: Row[]): TableInfo[] {
    return rows.map((r) => ({
      database: str(r.db),
      name: str(r.name),
      type: str(r.type).includes('VIEW') ? 'view' : 'table',
      engine: r.engine ? str(r.engine) : undefined,
      rowEstimate: num(r.row_estimate),
      dataBytes: num(r.data_bytes),
      comment: r.comment ? str(r.comment) : undefined,
    }));
  }

  private static readonly TABLE_COLUMNS = `TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
    TABLE_ROWS AS row_estimate, DATA_LENGTH AS data_bytes, TABLE_COMMENT AS comment`;

  async listTables(database: string): Promise<TableInfo[]> {
    const rows = await this.meta(
      `SELECT ${MysqlDriver.TABLE_COLUMNS} FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database],
    );
    return this.tableRows(rows);
  }

  private columnRows(rows: Row[]): ColumnInfo[] {
    return rows.map((r) => {
      const key = str(r.col_key) as ColumnInfo['key'];
      const extra = str(r.extra);
      return {
        table: str(r.tbl),
        name: str(r.name),
        ordinal: Number(r.ord),
        dataType: str(r.data_type).toLowerCase(),
        columnType: str(r.column_type),
        nullable: str(r.nullable) === 'YES',
        defaultValue: r.dflt === null || r.dflt === undefined ? null : str(r.dflt),
        key: (['PRI', 'UNI', 'MUL'].includes(key) ? key : '') as ColumnInfo['key'],
        isPrimaryKey: key === 'PRI',
        isAutoIncrement: extra.toLowerCase().includes('auto_increment'),
        extra,
        comment: str(r.comment),
      };
    });
  }

  private static readonly COLUMN_SELECT = `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, ORDINAL_POSITION AS ord, DATA_TYPE AS data_type,
    COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS col_key, EXTRA AS extra,
    COLUMN_COMMENT AS comment FROM information_schema.COLUMNS`;

  private static readonly INDEX_SELECT = `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS non_unique,
    COLUMN_NAME AS col, SEQ_IN_INDEX AS seq, INDEX_TYPE AS type FROM information_schema.STATISTICS`;

  private static readonly FK_SELECT = `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS db, k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col,
    k.REFERENCED_TABLE_SCHEMA AS ref_db, k.REFERENCED_TABLE_NAME AS ref_tbl, k.REFERENCED_COLUMN_NAME AS ref_col,
    k.ORDINAL_POSITION AS ord, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME`;

  private indexRows(rows: Row[]): (IndexInfo & { database: string })[] {
    const byDb = new Map<string, Row[]>();
    for (const r of rows) {
      const db = str(r.db);
      byDb.set(db, [...(byDb.get(db) ?? []), r]);
    }
    return [...byDb.entries()].flatMap(([db, list]) =>
      groupIndexRows(
        list.map((r) => ({
          table: str(r.tbl),
          name: str(r.name),
          unique: Number(r.non_unique) === 0,
          column: r.col === null || r.col === undefined ? '(expression)' : str(r.col),
          seq: Number(r.seq),
          type: str(r.type),
        })),
      ).map((i) => ({ ...i, database: db })),
    );
  }

  private fkRows(rows: Row[]) {
    return groupForeignKeyRows(
      rows.map((r) => ({
        name: str(r.name),
        database: str(r.db),
        table: str(r.tbl),
        column: str(r.col),
        refDatabase: str(r.ref_db),
        refTable: str(r.ref_tbl),
        refColumn: str(r.ref_col),
        ordinal: Number(r.ord),
        onUpdate: str(r.on_update),
        onDelete: str(r.on_delete),
      })),
    );
  }

  async loadTableDetails(database: string, table: string): Promise<TableDetails> {
    const [tables, columns, indexes, fkRows] = await Promise.all([
      this.meta(`SELECT ${MysqlDriver.TABLE_COLUMNS} FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [database, table]),
      this.meta(`${MysqlDriver.COLUMN_SELECT} WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [database, table]),
      this.meta(`${MysqlDriver.INDEX_SELECT} WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [database, table]),
      this.meta(
        `${MysqlDriver.FK_SELECT} WHERE k.REFERENCED_TABLE_NAME IS NOT NULL
         AND ((k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?) OR (k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?))
         ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [database, table, database, table],
      ),
    ]);
    const info = this.tableRows(tables)[0];
    if (!info) throw new DeepDiveError(`Table ${database}.${table} was not found`, 'NOT_FOUND');
    const ownIndexes = this.indexRows(indexes);
    const fks = this.fkRows(fkRows);
    // Cardinality of incoming FKs needs the referencing tables' unique indexes.
    const others = [...new Set(fks.filter((f) => !(f.database === database && f.table === table)).map((f) => `${f.database}\u0000${f.table}`))];
    let otherIndexes: (IndexInfo & { database: string })[] = [];
    if (others.length > 0) {
      const pairs = others.map((k) => k.split('\u0000') as [string, string]);
      const rows = await this.meta(
        `${MysqlDriver.INDEX_SELECT} WHERE NON_UNIQUE = 0 AND (${pairs.map(() => '(TABLE_SCHEMA = ? AND TABLE_NAME = ?)').join(' OR ')})`,
        pairs.flat(),
      );
      otherIndexes = this.indexRows(rows);
    }
    const allIndexes = [...ownIndexes, ...otherIndexes];
    const withCardinality = fks.map((fk) => ({
      ...fk,
      cardinality: deriveCardinality(fk.columns, allIndexes.filter((i) => i.database === fk.database && i.table === fk.table)),
    }));
    return assembleTableDetails(info, this.columnRows(columns), ownIndexes, withCardinality);
  }

  async loadDatabaseSchema(database: string): Promise<DatabaseSchema> {
    const [tables, columns, indexes, fkRows] = await Promise.all([
      this.meta(`SELECT ${MysqlDriver.TABLE_COLUMNS} FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [database]),
      this.meta(`${MysqlDriver.COLUMN_SELECT} WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [database]),
      this.meta(`${MysqlDriver.INDEX_SELECT} WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [database]),
      this.meta(
        `${MysqlDriver.FK_SELECT} WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [database],
      ),
    ]);
    const idx = this.indexRows(indexes);
    const fks = applyCardinality(this.fkRows(fkRows), (db, t) => idx.filter((i) => i.database === db && i.table === t));
    return { database, tables: this.tableRows(tables), columns: this.columnRows(columns), indexes: idx.map(({ database: _d, ...i }) => i), foreignKeys: fks };
  }

  async searchMetadata(term: string, limit: number): Promise<MetadataHitWithoutConnection[]> {
    const like = `%${escapeLike(term.toLowerCase())}%`;
    const system = [...SYSTEM_DATABASES];
    const notSystem = (col: string) => `${col} NOT IN (${system.map(() => '?').join(', ')})`;
    const [dbs, tables, columns] = await Promise.all([
      this.meta(`SELECT SCHEMA_NAME AS db FROM information_schema.SCHEMATA WHERE LOWER(SCHEMA_NAME) LIKE ? ESCAPE '!' AND ${notSystem('SCHEMA_NAME')} ORDER BY SCHEMA_NAME LIMIT ?`, [like, ...system, limit]),
      this.meta(
        `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, TABLE_TYPE AS type FROM information_schema.TABLES
         WHERE LOWER(TABLE_NAME) LIKE ? ESCAPE '!' AND ${notSystem('TABLE_SCHEMA')} ORDER BY TABLE_SCHEMA, TABLE_NAME LIMIT ?`,
        [like, ...system, limit],
      ),
      this.meta(
        `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, COLUMN_NAME AS col, COLUMN_TYPE AS type FROM information_schema.COLUMNS
         WHERE LOWER(COLUMN_NAME) LIKE ? ESCAPE '!' AND ${notSystem('TABLE_SCHEMA')} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT ?`,
        [like, ...system, limit],
      ),
    ]);
    return [
      ...dbs.map((r) => ({ kind: 'database' as const, database: str(r.db) })),
      ...tables.map((r) => ({ kind: 'table' as const, database: str(r.db), table: str(r.tbl), detail: str(r.type).includes('VIEW') ? 'view' : 'table' })),
      ...columns.map((r) => ({ kind: 'column' as const, database: str(r.db), table: str(r.tbl), column: str(r.col), detail: str(r.type) })),
    ];
  }

  private getConnection(): Promise<PoolConnection> {
    const pool = this.requirePool();
    return new Promise((resolve, reject) => pool.getConnection((err, conn) => (err ? reject(this.wrap(err)) : resolve(conn))));
  }

  private simple(conn: PoolConnection, sql: string, values: readonly unknown[] = [], timeout?: number): Promise<ResultSetHeader> {
    return new Promise((resolve, reject) =>
      conn.query({ sql, values: values as unknown[], timeout }, (err, result) => (err ? reject(this.wrap(err)) : resolve(result as ResultSetHeader))),
    );
  }

  /** KILL QUERY through a fresh, short-lived connection so it works even when the pool is exhausted. */
  private async killQuery(threadId: number): Promise<void> {
    const killer = mysql.createConnection({ ...this.poolOptions, connectTimeout: 5000 } as mysql.ConnectionOptions);
    killer.on('error', () => undefined);
    await killer.promise().query(`KILL QUERY ${Number(threadId)}`).catch(() => undefined);
    await killer.promise().end().catch(() => killer.destroy());
  }

  private async useDatabase(conn: PoolConnection, database: string | undefined): Promise<PoolConnection> {
    const wanted = database ?? this.config.database ?? null;
    const current = this.currentDb.has(conn) ? this.currentDb.get(conn)! : (this.config.database ?? null);
    if (wanted === current) return conn;
    if (wanted === null) {
      // A connection cannot "un-USE" a database; replace it with a fresh one instead.
      conn.destroy();
      const fresh = await this.getConnection();
      return this.useDatabase(fresh, database);
    }
    await this.simple(conn, `USE ${quoteIdent(wanted)}`);
    this.currentDb.set(conn, wanted);
    return conn;
  }

  async query(sql: string, params: readonly CellValue[], options: QueryOptions): Promise<QueryResult> {
    if (options.signal?.aborted) throw new DeepDiveError('Query cancelled', 'CANCELLED');
    let conn = await this.getConnection();
    let reusable = true;
    const started = Date.now();
    try {
      conn = await this.useDatabase(conn, options.database);
      if (options.readOnly) await this.simple(conn, 'START TRANSACTION READ ONLY');
      const result = await this.streamQuery(conn, sql, params, options, () => {
        reusable = false;
      });
      if (options.readOnly && reusable) await this.simple(conn, 'ROLLBACK').catch(() => (reusable = false));
      return { ...result, durationMs: Date.now() - started };
    } catch (err) {
      reusable = false;
      throw this.wrap(err);
    } finally {
      if (reusable) conn.release();
      else conn.destroy();
    }
  }

  private streamQuery(
    conn: PoolConnection,
    sql: string,
    params: readonly CellValue[],
    options: QueryOptions,
    markBroken: () => void,
  ): Promise<Omit<QueryResult, 'durationMs'>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let fields: FieldPacket[] | undefined;
      const rows: CellValue[][] = [];
      let header: ResultSetHeader | undefined;
      let truncated = false;
      const threadId = conn.threadId;

      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) return reject(err);
        if (fields) {
          resolve({
            kind: 'rows',
            columns: fields.map((f): ResultColumn => ({ name: f.name, table: f.orgTable || undefined, type: fieldTypeName(f.columnType) })),
            rows,
            truncated,
          });
        } else {
          resolve({
            kind: 'ok',
            columns: [],
            rows: [],
            truncated: false,
            affectedRows: header?.affectedRows,
            insertId: header?.insertId ? String(header.insertId) : undefined,
          });
        }
      };
      const abortWith = (error: DeepDiveError) => {
        if (settled) return;
        markBroken();
        void this.killQuery(threadId);
        finish(error);
      };
      const onAbort = () => abortWith(new DeepDiveError('Query cancelled', 'CANCELLED'));
      const timer = setTimeout(
        () => abortWith(new DeepDiveError(`Query exceeded the ${Math.round(options.timeoutMs / 1000)}s timeout and was cancelled`, 'TIMEOUT')),
        options.timeoutMs,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const q = conn.query({ sql, values: params as unknown[], rowsAsArray: true });
      q.on('fields', (f: FieldPacket[]) => {
        fields = f;
      });
      q.on('result', (row: unknown) => {
        if (settled) return;
        if (Array.isArray(row)) {
          if (rows.length < options.maxRows) {
            rows.push(row.map(toCell));
          } else {
            // Stop reading: keep what we have, kill the rest of the query and discard this connection.
            truncated = true;
            markBroken();
            conn.pause();
            void this.killQuery(threadId);
            finish();
          }
        } else {
          header = row as ResultSetHeader;
        }
      });
      q.on('error', (err: unknown) => finish(err));
      q.on('end', () => finish());
    });
  }

  async transaction(statements: readonly Statement[], options: QueryOptions, verify?: (index: number, affectedRows: number) => void): Promise<number[]> {
    const conn = await this.getConnection();
    let reusable = true;
    try {
      await this.simple(conn, 'START TRANSACTION', [], options.timeoutMs);
      const affected: number[] = [];
      try {
        for (const [i, st] of statements.entries()) {
          if (options.signal?.aborted) throw new DeepDiveError('Cancelled before commit', 'CANCELLED');
          const res = await this.simple(conn, st.sql, st.params, options.timeoutMs);
          affected.push(res.affectedRows);
          verify?.(i, res.affectedRows);
        }
        await this.simple(conn, 'COMMIT', [], options.timeoutMs);
        return affected;
      } catch (err) {
        await this.simple(conn, 'ROLLBACK', [], options.timeoutMs).catch(() => (reusable = false));
        throw err;
      }
    } catch (err) {
      reusable = false;
      throw this.wrap(err);
    } finally {
      if (reusable) conn.release();
      else conn.destroy();
    }
  }
}

const TYPE_NAMES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint',
  9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal',
  247: 'enum', 248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
};

function fieldTypeName(type: number | undefined): string | undefined {
  return type === undefined ? undefined : TYPE_NAMES[type];
}
