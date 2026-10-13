// Domain types shared by the extension host and the webview.
// This file must stay free of runtime dependencies on Node, VS Code or the DOM.

export type CellValue = string | number | boolean | null;

export type ConnectionKind = 'mysql' | 'demo';
export type DemoDataset = 'acme' | 'lake';
export type TlsMode = 'disabled' | 'required' | 'verify';
export type Environment = 'development' | 'staging' | 'production' | 'other';

export interface TlsConfig {
  mode: TlsMode;
  /** Absolute paths on the extension host machine. Read by the host only. */
  caPath?: string;
  certPath?: string;
  keyPath?: string;
}

/** Persisted connection settings. Never contains the password (that lives in SecretStorage). */
export interface ConnectionConfig {
  id: string;
  name: string;
  color: string;
  kind: ConnectionKind;
  demoDataset?: DemoDataset;
  environment: Environment;
  host: string;
  port: number;
  user: string;
  /** Optional default database. */
  database?: string;
  /** Read-only connections refuse every write statement. Defaults to true. */
  readOnly: boolean;
  tls: TlsConfig;
  connectTimeoutMs: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionSummary {
  config: ConnectionConfig;
  status: ConnectionStatus;
  hasPassword: boolean;
  serverVersion?: string;
  error?: string;
}

export interface DatabaseInfo {
  name: string;
  tableCount?: number;
  sizeBytes?: number;
  isSystem: boolean;
}

export interface TableInfo {
  database: string;
  name: string;
  type: 'table' | 'view';
  engine?: string;
  /** Estimate from information_schema / statistics. Not exact. */
  rowEstimate?: number;
  dataBytes?: number;
  comment?: string;
}

export type ColumnKey = 'PRI' | 'UNI' | 'MUL' | '';

export interface ColumnInfo {
  table: string;
  name: string;
  ordinal: number;
  /** Base type, lower case, e.g. "varchar". */
  dataType: string;
  /** Full type, e.g. "varchar(255)". */
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  key: ColumnKey;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  extra: string;
  comment: string;
}

export interface IndexInfo {
  table: string;
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  type: string;
}

export type Cardinality = 'many-to-one' | 'one-to-one';

export interface ForeignKeyInfo {
  name: string;
  database: string;
  table: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
  /** Derived from unique indexes on the referencing columns; only set when it can be determined reliably. */
  cardinality: Cardinality;
}

export interface TableDetails {
  table: TableInfo;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKey: string[];
  /** Foreign keys declared on this table. */
  foreignKeys: ForeignKeyInfo[];
  /** Foreign keys in the same database that reference this table. */
  referencedBy: ForeignKeyInfo[];
}

export interface DatabaseSchema {
  database: string;
  tables: TableInfo[];
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

// ---------- Filters ----------

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'not_in'
  | 'between'
  | 'is_null'
  | 'is_not_null'
  | 'is_true'
  | 'is_false'
  | 'is_empty'
  | 'is_not_empty';

export type FilterScalar = string | number | boolean | null;

export interface FilterCondition {
  kind: 'condition';
  id: string;
  /** Table alias (query builder only). Omitted in the single-table data browser. */
  source?: string;
  column: string;
  operator: FilterOperator;
  value?: FilterScalar;
  value2?: FilterScalar;
  values?: FilterScalar[];
}

export interface FilterGroup {
  kind: 'group';
  id: string;
  combinator: 'and' | 'or';
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export interface TableQueryRequest {
  database: string;
  table: string;
  /** Visible columns in display order. Empty/omitted means all columns. */
  columns?: string[];
  filter?: FilterGroup;
  sort?: SortSpec[];
  limit: number;
  offset: number;
}

// ---------- Visual query builder ----------

export type JoinType = 'inner' | 'left' | 'right';
export type Aggregate = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';

export interface QueryTable {
  alias: string;
  database: string;
  table: string;
  position?: { x: number; y: number };
}

export interface QueryJoin {
  id: string;
  type: JoinType;
  leftAlias: string;
  leftColumn: string;
  rightAlias: string;
  rightColumn: string;
}

export interface QueryColumn {
  id: string;
  source: string;
  /** "*" selects all columns of the source (only valid without aggregate, or with count). */
  column: string;
  aggregate?: Aggregate;
  as?: string;
}

export interface QueryColumnRef {
  source: string;
  column: string;
}

export interface QueryOrder extends QueryColumnRef {
  direction: 'asc' | 'desc';
}

export interface QueryModel {
  tables: QueryTable[];
  joins: QueryJoin[];
  columns: QueryColumn[];
  filter: FilterGroup;
  groupBy: QueryColumnRef[];
  orderBy: QueryOrder[];
  limit: number | null;
  distinct: boolean;
}

// ---------- Results ----------

export interface ResultColumn {
  name: string;
  type?: string;
  table?: string;
}

export interface QueryResult {
  kind: 'rows' | 'ok';
  columns: ResultColumn[];
  rows: CellValue[][];
  /** True when rows were dropped because the configured row limit was reached. */
  truncated: boolean;
  affectedRows?: number;
  insertId?: string;
  durationMs: number;
}

export interface SqlStatementResult {
  sql: string;
  result?: QueryResult;
  error?: string;
}

export interface TablePage {
  sql: string;
  /** SQL with parameters inlined, for display/editing only. */
  displaySql: string;
  columns: ResultColumn[];
  /** Columns that were fetched only because they are part of the primary key. */
  hiddenColumns: string[];
  rows: CellValue[][];
  hasMore: boolean;
  offset: number;
  durationMs: number;
}

export interface BuiltQuery {
  sql: string;
  params: CellValue[];
  displaySql: string;
  notes: string[];
}

export interface RowEdit {
  /** Primary key values identifying the row (as originally loaded). */
  key: Record<string, CellValue>;
  changes: Record<string, CellValue>;
}

export interface EditResult {
  committed: boolean;
  statements: number;
  affectedRows: number;
  message: string;
}

// ---------- Search ----------

export interface MetadataHit {
  kind: 'database' | 'table' | 'column';
  connectionId: string;
  database: string;
  table?: string;
  column?: string;
  detail?: string;
}

export interface DataSearchRequest {
  searchId: string;
  connectionId: string;
  database: string;
  tables: string[];
  /** Optional explicit column selection per table. Defaults to text-like columns. */
  columns?: Record<string, string[]>;
  term: string;
  match: 'contains' | 'equals';
  perTableLimit: number;
}

export interface DataSearchTableResult {
  connectionId: string;
  database: string;
  table: string;
  searchedColumns: string[];
  columns: ResultColumn[];
  rows: CellValue[][];
  error?: string;
  limited: boolean;
}

export interface DataSearchProgress {
  searchId: string;
  done: number;
  total: number;
  current?: string;
  finished: boolean;
  cancelled?: boolean;
  result?: DataSearchTableResult;
}

export interface LogEntry {
  id: string;
  time: number;
  level: 'info' | 'warn' | 'error';
  connectionId?: string;
  message: string;
  sql?: string;
  durationMs?: number;
  rows?: number;
}

export interface UiSettings {
  pageSize: number;
  maxResultRows: number;
  queryTimeoutMs: number;
  maxTablesPerDatabase: number;
  maxTablesPerDataSearch: number;
}
