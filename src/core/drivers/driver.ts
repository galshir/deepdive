import type { CellValue, DatabaseInfo, DatabaseSchema, MetadataHit, QueryResult, TableDetails, TableInfo } from '../../shared/model';
import type { Dialect } from '../sql/identifiers';
import type { Statement } from '../sql/edits';

export interface QueryOptions {
  timeoutMs: number;
  /** Rows beyond this limit are discarded and the result is flagged as truncated. */
  maxRows: number;
  signal?: AbortSignal;
  /** Default database for unqualified names. */
  database?: string;
  /** Execute inside a read-only transaction where the engine supports it (MySQL). */
  readOnly?: boolean;
}

export type MetadataHitWithoutConnection = Omit<MetadataHit, 'connectionId'>;

export interface DbDriver {
  readonly dialect: Dialect;
  /** Opens resources and verifies connectivity. Returns the server version string. */
  connect(): Promise<string>;
  close(): Promise<void>;
  listDatabases(): Promise<DatabaseInfo[]>;
  listTables(database: string): Promise<TableInfo[]>;
  /** Throws NOT_FOUND if the table does not exist. */
  loadTableDetails(database: string, table: string): Promise<TableDetails>;
  loadDatabaseSchema(database: string): Promise<DatabaseSchema>;
  searchMetadata(term: string, limit: number): Promise<MetadataHitWithoutConnection[]>;
  query(sql: string, params: readonly CellValue[], options: QueryOptions): Promise<QueryResult>;
  /**
   * Runs statements in one transaction. `verify` is called with each statement's affected row count and
   * may throw to force a rollback. Resolves only after the server confirmed COMMIT.
   */
  transaction(statements: readonly Statement[], options: QueryOptions, verify?: (index: number, affectedRows: number) => void): Promise<number[]>;
}

export const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
