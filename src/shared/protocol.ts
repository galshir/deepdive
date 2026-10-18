// Typed message protocol between the webview and the extension host.
// The host validates every incoming request with these zod schemas; the webview only imports the types.
import { z } from 'zod';
import type {
  BuiltQuery,
  ConnectionSummary,
  DataSearchProgress,
  DatabaseInfo,
  DatabaseSchema,
  EditResult,
  FilterGroup,
  FilterNode,
  HistoryEntry,
  LogEntry,
  MetadataHit,
  MultiRunPreview,
  MultiRunProgress,
  MultiRunSnapshot,
  MultiRunSummary,
  SavedQuery,
  SqlStatementResult,
  TableDetails,
  TableInfo,
  TableLocation,
  TablePage,
  UiSettings,
} from './model';

const MAX_NAME = 64;
const id = z.string().min(1).max(128);
/** Identifiers are validated again against live schema metadata on the host. */
const ident = z.string().min(1).max(MAX_NAME);
const scalar = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);

export const filterOperatorSchema = z.enum([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'in', 'not_in', 'between', 'is_null', 'is_not_null', 'is_true', 'is_false', 'is_empty', 'is_not_empty',
]);

const filterConditionSchema = z.object({
  kind: z.literal('condition'),
  id,
  source: ident.optional(),
  column: ident,
  operator: filterOperatorSchema,
  value: scalar.optional(),
  value2: scalar.optional(),
  values: z.array(scalar).max(1000).optional(),
});

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    kind: z.literal('group'),
    id,
    combinator: z.enum(['and', 'or']),
    children: z.array(z.union([filterConditionSchema, filterGroupSchema]) as z.ZodType<FilterNode>).max(200),
  }),
);

const sortSchema = z.object({ column: ident, direction: z.enum(['asc', 'desc']) });

export const tableQuerySchema = z.object({
  database: ident,
  table: ident,
  columns: z.array(ident).max(4096).optional(),
  filter: filterGroupSchema.optional(),
  sort: z.array(sortSchema).max(16).optional(),
  limit: z.number().int().min(1).max(10_000),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const aliasSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Aliases may contain letters, digits and _ only');
const colRef = z.object({ source: aliasSchema, column: ident });

export const queryModelSchema = z.object({
  tables: z
    .array(
      z.object({
        alias: aliasSchema,
        database: ident,
        table: ident,
        position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
      }),
    )
    .max(32),
  joins: z
    .array(
      z.object({
        id,
        type: z.enum(['inner', 'left', 'right']),
        leftAlias: aliasSchema,
        leftColumn: ident,
        rightAlias: aliasSchema,
        rightColumn: ident,
      }),
    )
    .max(64),
  columns: z
    .array(
      z.object({
        id,
        source: aliasSchema,
        column: z.union([ident, z.literal('*')]),
        aggregate: z.enum(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']).optional(),
        as: aliasSchema.optional(),
      }),
    )
    .max(512),
  filter: filterGroupSchema,
  groupBy: z.array(colRef).max(64),
  orderBy: z.array(colRef.extend({ direction: z.enum(['asc', 'desc']) })).max(16),
  limit: z.number().int().min(1).max(1_000_000).nullable(),
  distinct: z.boolean(),
});

export const connectionInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  kind: z.enum(['mysql', 'demo']),
  demoDataset: z.enum(['acme', 'lake']).optional(),
  environment: z.enum(['development', 'staging', 'production', 'other']),
  host: z.string().trim().max(255),
  port: z.number().int().min(1).max(65535),
  user: z.string().max(255),
  database: z.string().max(MAX_NAME).optional(),
  readOnly: z.boolean(),
  tls: z.object({
    mode: z.enum(['disabled', 'required', 'verify']),
    caPath: z.string().max(1024).optional(),
    certPath: z.string().max(1024).optional(),
    keyPath: z.string().max(1024).optional(),
  }),
  connectTimeoutMs: z.number().int().min(1000).max(120_000),
});
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

const MAX_SQL = 1_000_000;
/** Upper bound for schema validation; the configured deepdive.multiRun.maxDatabases is enforced on the host. */
const MAX_TARGET_DATABASES = 5000;

export const savedQueryInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10),
  sql: z.string().min(1).max(MAX_SQL),
  connectionId: id.optional(),
  database: ident.optional(),
});

const rowEditSchema = z.object({
  key: z.record(ident, scalar),
  changes: z.record(ident, scalar),
});

/** All requests the webview may send. */
export const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init') }),
  z.object({ type: z.literal('listConnections') }),
  z.object({
    type: z.literal('saveConnection'),
    config: connectionInputSchema,
    /** undefined keeps the stored password, null clears it, a string replaces it. */
    password: z.string().max(4096).nullable().optional(),
  }),
  z.object({ type: z.literal('deleteConnection'), connectionId: id }),
  z.object({ type: z.literal('testConnection'), config: connectionInputSchema, password: z.string().max(4096).nullable().optional() }),
  z.object({ type: z.literal('connect'), connectionId: id }),
  z.object({ type: z.literal('disconnect'), connectionId: id }),
  z.object({ type: z.literal('addDemoConnections') }),
  z.object({ type: z.literal('listDatabases'), connectionId: id, refresh: z.boolean().optional() }),
  z.object({ type: z.literal('listTables'), connectionId: id, database: ident, refresh: z.boolean().optional() }),
  z.object({ type: z.literal('getTableDetails'), connectionId: id, database: ident, table: ident, refresh: z.boolean().optional() }),
  z.object({ type: z.literal('getDatabaseSchema'), connectionId: id, database: ident, refresh: z.boolean().optional() }),
  z.object({ type: z.literal('fetchTableRows'), connectionId: id, queryId: id, query: tableQuerySchema }),
  z.object({
    type: z.literal('countRows'),
    connectionId: id,
    queryId: id,
    database: ident,
    table: ident,
    filter: filterGroupSchema.optional(),
  }),
  z.object({ type: z.literal('buildQuery'), connectionId: id, model: queryModelSchema }),
  z.object({ type: z.literal('runQueryModel'), connectionId: id, queryId: id, model: queryModelSchema }),
  z.object({
    type: z.literal('runSql'),
    connectionId: id,
    queryId: id,
    sql: z.string().min(1).max(MAX_SQL),
    database: ident.optional(),
    /** Set when the script was loaded from a saved query, to update its run statistics. */
    savedQueryId: id.optional(),
  }),
  z.object({ type: z.literal('listSavedQueries') }),
  z.object({ type: z.literal('saveQuery'), query: savedQueryInputSchema }),
  z.object({ type: z.literal('deleteSavedQuery'), id }),
  z.object({
    type: z.literal('listHistory'),
    term: z.string().max(200).optional(),
    connectionId: id.optional(),
    limit: z.number().int().min(1).max(5000),
  }),
  z.object({ type: z.literal('deleteHistoryEntry'), id }),
  z.object({ type: z.literal('clearHistory') }),
  z.object({ type: z.literal('locateTable'), connectionId: id, table: ident, column: ident.optional() }),
  z.object({
    type: z.literal('previewMultiRun'),
    connectionId: id,
    sql: z.string().min(1).max(MAX_SQL),
    databases: z.array(ident).min(1).max(MAX_TARGET_DATABASES),
  }),
  z.object({
    type: z.literal('runSqlMulti'),
    connectionId: id,
    runId: id,
    sql: z.string().min(1).max(MAX_SQL),
    databases: z.array(ident).min(1).max(MAX_TARGET_DATABASES),
    concurrency: z.number().int().min(1).max(32),
  }),
  z.object({
    type: z.literal('retryMultiRun'),
    runId: id,
    /** failed: unchanged databases (failed or not run); partial: partially applied ones; database: one database. */
    mode: z.enum(['failed', 'partial', 'database']),
    database: ident.optional(),
  }),
  z.object({ type: z.literal('cancelMultiRun'), runId: id }),
  z.object({ type: z.literal('cancelQuery'), queryId: id }),
  z.object({
    type: z.literal('applyEdits'),
    connectionId: id,
    database: ident,
    table: ident,
    updates: z.array(rowEditSchema).max(1000),
    deletes: z.array(z.record(ident, scalar)).max(1000),
  }),
  z.object({
    type: z.literal('searchMetadata'),
    term: z.string().trim().min(1).max(200),
    connectionIds: z.array(id).max(64).optional(),
    limit: z.number().int().min(1).max(2000),
  }),
  z.object({
    type: z.literal('searchData'),
    request: z.object({
      searchId: id,
      connectionId: id,
      database: ident,
      tables: z.array(ident).min(1).max(500),
      columns: z.record(ident, z.array(ident).max(1024)).optional(),
      term: z.string().min(1).max(500),
      match: z.enum(['contains', 'equals']),
      perTableLimit: z.number().int().min(1).max(1000),
    }),
  }),
  z.object({ type: z.literal('cancelSearch'), searchId: id }),
  z.object({ type: z.literal('copyText'), text: z.string().max(50_000_000) }),
  z.object({ type: z.literal('openSqlDocument'), sql: z.string().max(10_000_000) }),
]);

export type Request = z.infer<typeof requestSchema>;
export type RequestType = Request['type'];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

export interface InitResult {
  connections: ConnectionSummary[];
  settings: UiSettings;
  savedQueries: SavedQuery[];
}

/** Result type for every request. */
export interface ResponseMap {
  init: InitResult;
  listConnections: ConnectionSummary[];
  saveConnection: ConnectionSummary;
  deleteConnection: boolean;
  testConnection: { ok: true; serverVersion: string };
  connect: ConnectionSummary;
  disconnect: ConnectionSummary;
  addDemoConnections: ConnectionSummary[];
  listDatabases: DatabaseInfo[];
  listTables: TableInfo[];
  getTableDetails: TableDetails;
  getDatabaseSchema: DatabaseSchema;
  fetchTableRows: TablePage;
  countRows: { count: number; sql: string };
  buildQuery: BuiltQuery;
  runQueryModel: { built: BuiltQuery; statement: SqlStatementResult };
  runSql: { statements: SqlStatementResult[]; cancelled: boolean };
  listSavedQueries: SavedQuery[];
  saveQuery: SavedQuery;
  deleteSavedQuery: boolean;
  listHistory: HistoryEntry[];
  deleteHistoryEntry: boolean;
  clearHistory: boolean;
  locateTable: TableLocation[];
  previewMultiRun: MultiRunPreview;
  runSqlMulti: MultiRunSnapshot;
  retryMultiRun: MultiRunSnapshot;
  cancelMultiRun: boolean;
  cancelQuery: boolean;
  applyEdits: EditResult;
  searchMetadata: { hits: MetadataHit[]; limited: boolean; errors: string[] };
  searchData: { started: true };
  cancelSearch: boolean;
  copyText: boolean;
  openSqlDocument: boolean;
}

export type HostEvent =
  | { type: 'connectionsChanged'; connections: ConnectionSummary[] }
  | { type: 'searchProgress'; progress: DataSearchProgress }
  | { type: 'log'; entry: LogEntry }
  | { type: 'settingsChanged'; settings: UiSettings }
  | { type: 'openSql'; sql: string; connectionId?: string }
  | { type: 'focusConnection'; connectionId: string }
  | { type: 'openConnectionForm' }
  | { type: 'savedQueriesChanged'; savedQueries: SavedQuery[] }
  | { type: 'historyChanged' }
  | { type: 'multiRunProgress'; progress: MultiRunProgress }
  | { type: 'multiRunFinished'; summary: MultiRunSummary };

export interface ErrorPayload {
  message: string;
  code?: string;
}

export type WebviewToHost = { kind: 'request'; id: number; payload: Request };

export type HostToWebview =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: ErrorPayload }
  | { kind: 'event'; event: HostEvent };

export const envelopeSchema = z.object({
  kind: z.literal('request'),
  id: z.number().int().nonnegative(),
  payload: z.unknown(),
});
