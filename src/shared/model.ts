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
  /** Server error code (e.g. ER_DUP_FIELDNAME) or DeepDive error code (e.g. TIMEOUT). */
  errorCode?: string;
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
  poolSize: number;
  historyEnabled: boolean;
  multiRunMaxDatabases: number;
  multiRunConcurrency: number;
}

// ---------- Saved queries & history ----------

export interface SavedQuery {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  sql: string;
  /** Connection and default database the query was saved for, if the user chose to remember them. */
  connectionId?: string;
  database?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;
}

export type SavedQueryInput = Pick<SavedQuery, 'name' | 'tags' | 'sql'> & Partial<Pick<SavedQuery, 'id' | 'description' | 'connectionId' | 'database'>>;

export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId?: string;
  database?: string;
  /** Set for runs on multiple databases: how many databases were targeted. */
  databaseCount?: number;
  executedAt: number;
  status: 'ok' | 'error' | 'cancelled';
  durationMs: number;
  rowCount?: number;
  error?: string;
  /** Consecutive identical runs are folded into one entry. */
  runs: number;
}

// ---------- Running on multiple databases ----------

export type MultiRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'partial' | 'not_run';
export type MultiRunFinalStatus = Exclude<MultiRunStatus, 'pending' | 'running'>;

export interface MultiRunStatement {
  status: 'ok' | 'error' | 'not_run';
  /** Attempt that produced this status; statements applied earlier keep their original attempt. */
  attempt?: number;
  affectedRows?: number;
  rowCount?: number;
  durationMs?: number;
  error?: string;
  errorCode?: string;
}

export interface MultiRunTarget {
  database: string;
  status: MultiRunStatus;
  /** One entry per statement of the script, in order. */
  statements: MultiRunStatement[];
  failedStatementIndex?: number;
  /** Duration of the latest attempt on this database. */
  durationMs: number;
  attempts: { attempt: number; status: MultiRunFinalStatus; failedStatementIndex?: number }[];
}

export interface MultiRunErrorGroup {
  code: string;
  /** The error message with the database name replaced by <db>. */
  message: string;
  databases: string[];
}

export interface MultiRunSummary {
  runId: string;
  connectionId: string;
  statements: string[];
  total: number;
  attempt: number;
  running: boolean;
  cancelled: boolean;
  startedAt: number;
  finishedAt?: number;
  counts: Record<MultiRunFinalStatus, number>;
  errorGroups: MultiRunErrorGroup[];
}

export interface MultiRunSnapshot {
  summary: MultiRunSummary;
  targets: MultiRunTarget[];
}

export interface MultiRunProgress {
  runId: string;
  attempt: number;
  done: number;
  total: number;
  target: MultiRunTarget;
  /** Result sets of read statements from this attempt, keyed by statement index. */
  results?: Record<number, QueryResult>;
}

export interface MultiRunPreview {
  statements: { sql: string; readOnly: boolean; keyword: string }[];
  writes: number;
  /** Blocking problems: the run is refused while any exist. */
  problems: string[];
  warnings: string[];
}

export interface TableLocation {
  database: string;
  /** Only set when a column was asked for. */
  hasColumn?: boolean;
}

// ---------- Schema compare ----------

export interface SchemaCompareOptions {
  ignoreColumnOrder: boolean;
  ignoreComments: boolean;
  /** Treat MySQL version differences as equal: integer display widths (int(11) vs int) and default-value spelling. */
  normalizeTypes: boolean;
  /** Match table, column, index and constraint names case-insensitively. */
  ignoreCase: boolean;
}

export interface SchemaRef {
  connectionId: string;
  database: string;
}

/** Relative to the source: only_source means "missing in target", only_target means "missing in source". */
export type DiffStatus = 'same' | 'only_source' | 'only_target' | 'changed';

export interface FieldDiff {
  field: string;
  source: string | null;
  target: string | null;
}

export interface ObjectDiff {
  kind: 'column' | 'index' | 'foreignKey';
  /** Source name when the object exists in the source, otherwise the target name. */
  name: string;
  /** Set when an index or foreign key has the same definition but a different name in the target. */
  targetName?: string;
  status: DiffStatus;
  changes: FieldDiff[];
  /** Human-readable definitions, for side-by-side display. */
  source?: string;
  target?: string;
}

export interface TableDiff {
  name: string;
  /** Set when the target spells the name differently (only possible when ignoring case). */
  targetName?: string;
  type: 'table' | 'view';
  status: DiffStatus;
  /** Table-level changes (type, engine, comment). */
  changes: FieldDiff[];
  columns: ObjectDiff[];
  indexes: ObjectDiff[];
  foreignKeys: ObjectDiff[];
}

export interface SchemaDiffSummary {
  tables: Record<DiffStatus, number>;
  /** Column, index and foreign-key differences inside tables present on both sides. */
  objects: Record<Exclude<DiffStatus, 'same'>, number>;
}

export interface SchemaDiff {
  source: SchemaRef;
  target: SchemaRef;
  options: SchemaCompareOptions;
  tables: TableDiff[];
  summary: SchemaDiffSummary;
  comparedAt: number;
}

export interface ServerCompareRow {
  database: string;
  status: DiffStatus | 'error';
  summary?: SchemaDiffSummary;
  error?: string;
}

export interface ServerCompareProgress {
  compareId: string;
  done: number;
  total: number;
  current?: string;
  rows?: ServerCompareRow[];
  finished: boolean;
  cancelled?: boolean;
  /** Set when the comparison could not run at all (e.g. a connection dropped). */
  error?: string;
}

export interface SyncScript {
  /** The script with explanatory comments, ready to open in the SQL editor. */
  script: string;
  /** Executable statements, in order. */
  statements: string[];
  warnings: string[];
}
