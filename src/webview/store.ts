import { create } from 'zustand';
import type {
  CellValue,
  ConnectionConfig,
  ConnectionSummary,
  DataSearchTableResult,
  DatabaseInfo,
  DatabaseSchema,
  FilterGroup,
  ForeignKeyInfo,
  LogEntry,
  MetadataHit,
  MultiRunSnapshot,
  MultiRunSummary,
  MultiRunTarget,
  QueryModel,
  QueryResult,
  SavedQuery,
  SchemaCompareOptions,
  SchemaDiff,
  ServerCompareRow,
  SortSpec,
  SqlStatementResult,
  TableDetails,
  TableInfo,
  TablePage,
  UiSettings,
} from '../shared/model';
import { emptyGroup } from './lib/filters';
import { errorMessage, rpc } from './lib/rpc';
import { key, uid } from './lib/util';

export interface Load<T> {
  status: 'loading' | 'ready' | 'error';
  data?: T;
  error?: string;
}

export type Selection =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'database'; connectionId: string; database: string }
  | { kind: 'table'; connectionId: string; database: string; table: string }
  | { kind: 'column'; connectionId: string; database: string; table: string; column: string }
  | { kind: 'relationship'; connectionId: string; fk: ForeignKeyInfo }
  | null;

export type FixedTab = 'graph' | 'schema' | 'builder' | 'sql' | 'search' | 'compare';
export interface DataTab {
  id: string;
  kind: 'data';
  connectionId: string;
  database: string;
  table: string;
}
export type Tab = { id: FixedTab; kind: FixedTab } | DataTab;

export interface DataTabState {
  columns?: string[];
  draftFilter: FilterGroup;
  filter: FilterGroup;
  sort: SortSpec[];
  offset: number;
  pageSize: number;
  page?: TablePage;
  loading: boolean;
  error?: string;
  count?: { value?: number; loading: boolean; error?: string };
  showFilters: boolean;
  showSql: boolean;
  editMode: boolean;
  /** rowIndex -> column name -> new value */
  changes: Record<number, Record<string, CellValue>>;
  deletes: number[];
  queryId?: string;
}

export interface SchemaFocus {
  connectionId?: string;
  database?: string;
  table?: string;
  depth: number;
  compact: boolean;
  hideIsolated: boolean;
}

export interface BuilderState {
  connectionId?: string;
  database?: string;
  model: QueryModel;
  running: boolean;
  queryId?: string;
  result?: SqlStatementResult;
  sql?: string;
  notes: string[];
  previewError?: string;
}

/** Client-side view of a run on multiple databases, kept up to date by host events. */
export interface MultiRunView {
  summary: MultiRunSummary;
  /** Database names in the order they were requested. */
  order: string[];
  targets: Record<string, MultiRunTarget>;
  /** Result sets of read statements, per database and statement index. */
  results: Record<string, Record<number, QueryResult>>;
}

export interface SqlState {
  connectionId?: string;
  database?: string;
  text: string;
  running: boolean;
  queryId?: string;
  results: SqlStatementResult[];
  cancelled: boolean;
  activeResult: number;
  /** The saved query the editor text was loaded from, if any. */
  savedQueryId?: string;
  mode: 'single' | 'multi';
  /** Databases chosen for multi mode; only valid for `connectionId`. */
  targets: { connectionId?: string; databases: string[] };
  concurrency: number;
  multiRun?: MultiRunView;
  multiStarting: boolean;
  multiError?: string;
}

export interface CompareSide {
  connectionId?: string;
  database?: string;
}

export interface ServerCompareState {
  compareId: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  running: boolean;
  done: number;
  total: number;
  current?: string;
  rows: ServerCompareRow[];
  cancelled?: boolean;
  error?: string;
}

export interface CompareState {
  level: 'schema' | 'server';
  source: CompareSide;
  target: CompareSide;
  options: SchemaCompareOptions;
  schema?: { loading: boolean; error?: string; diff?: SchemaDiff };
  server?: ServerCompareState;
}

export const DEFAULT_COMPARE_OPTIONS: SchemaCompareOptions = { ignoreColumnOrder: true, ignoreComments: true, normalizeTypes: false, ignoreCase: false };

export interface SearchState {
  mode: 'metadata' | 'data';
  term: string;
  /** Incremented to ask the Search view to run a metadata search (works even before it mounts). */
  runToken: number;
  connectionIds: string[];
  metadata?: { hits: MetadataHit[]; limited: boolean; errors: string[]; loading: boolean; error?: string };
  data: {
    connectionId?: string;
    database?: string;
    tables: string[];
    match: 'contains' | 'equals';
    perTableLimit: number;
    searchId?: string;
    running: boolean;
    done: number;
    total: number;
    current?: string;
    cancelled?: boolean;
    results: DataSearchTableResult[];
  };
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
}

export const emptyModel = (): QueryModel => ({
  tables: [],
  joins: [],
  columns: [],
  filter: emptyGroup(),
  groupBy: [],
  orderBy: [],
  limit: 100,
  distinct: false,
});

interface Store {
  ready: boolean;
  connections: ConnectionSummary[];
  settings: UiSettings;
  activeConnectionId?: string;
  databases: Record<string, Load<DatabaseInfo[]>>;
  tables: Record<string, Load<TableInfo[]>>;
  details: Record<string, Load<TableDetails>>;
  schemas: Record<string, Load<DatabaseSchema>>;
  expanded: Record<string, boolean>;
  tableLimit: Record<string, number>;
  positions: Record<string, { x: number; y: number }>;
  showSystemDatabases: boolean;
  selection: Selection;
  tabs: Tab[];
  activeTab: string;
  dataTabs: Record<string, DataTabState>;
  schemaFocus: SchemaFocus;
  builder: BuilderState;
  sql: SqlState;
  search: SearchState;
  compare: CompareState;
  logs: LogEntry[];
  toasts: Toast[];
  connectionForm: { open: boolean; editing?: ConnectionConfig };
  savedQueries: SavedQuery[];
  /** Bumped whenever the host reports a history change, so open history lists refetch. */
  historyVersion: number;

  set: (patch: Partial<Store> | ((s: Store) => Partial<Store>)) => void;
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  setConnections: (c: ConnectionSummary[]) => void;
  setActiveConnection: (id: string | undefined) => void;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  loadDatabases: (connectionId: string, refresh?: boolean) => Promise<DatabaseInfo[] | undefined>;
  loadTables: (connectionId: string, database: string, refresh?: boolean) => Promise<TableInfo[] | undefined>;
  loadDetails: (connectionId: string, database: string, table: string, refresh?: boolean) => Promise<TableDetails | undefined>;
  loadSchema: (connectionId: string, database: string, refresh?: boolean) => Promise<DatabaseSchema | undefined>;
  refreshConnection: (connectionId: string) => Promise<void>;
  toggleExpanded: (id: string, value?: boolean) => void;
  select: (s: Selection) => void;
  openTab: (tab: FixedTab) => void;
  openTable: (connectionId: string, database: string, table: string, init?: Partial<DataTabState>) => void;
  closeTab: (id: string) => void;
  updateDataTab: (id: string, patch: Partial<DataTabState> | ((s: DataTabState) => Partial<DataTabState>)) => void;
  updateBuilder: (patch: Partial<BuilderState> | ((s: BuilderState) => Partial<BuilderState>)) => void;
  updateSql: (patch: Partial<SqlState> | ((s: SqlState) => Partial<SqlState>)) => void;
  updateSearch: (patch: Partial<SearchState> | ((s: SearchState) => Partial<SearchState>)) => void;
  updateCompare: (patch: Partial<CompareState> | ((s: CompareState) => Partial<CompareState>)) => void;
  addLog: (entry: LogEntry) => void;
  openSqlWith: (sql: string, connectionId?: string, database?: string) => void;
  searchMetadata: (term: string) => void;
  /**
   * Shows an empty report for a run that is about to start, so progress events that overtake the
   * runSqlMulti response are not lost. Returns the report it replaced, to restore if the run is refused.
   */
  beginMultiRun: (runId: string, connectionId: string, databases: string[]) => MultiRunView | undefined;
  /** Merges a host snapshot without rolling back newer state already received through events. */
  applyMultiRunSnapshot: (snapshot: MultiRunSnapshot) => void;
}

const FIXED_TABS: Tab[] = [
  { id: 'graph', kind: 'graph' },
  { id: 'schema', kind: 'schema' },
  { id: 'builder', kind: 'builder' },
  { id: 'sql', kind: 'sql' },
  { id: 'search', kind: 'search' },
  { id: 'compare', kind: 'compare' },
];

const DEFAULT_SETTINGS: UiSettings = {
  pageSize: 100,
  maxResultRows: 1000,
  queryTimeoutMs: 30000,
  maxTablesPerDatabase: 150,
  maxTablesPerDataSearch: 50,
  poolSize: 4,
  historyEnabled: true,
  multiRunMaxDatabases: 500,
  multiRunConcurrency: 1,
};

export const dataTabId = (connectionId: string, database: string, table: string) => `data:${key(connectionId, database, table)}`;

export const useStore = create<Store>((set, get) => {
  /** Loads into a keyed Load<T> map, de-duplicating concurrent requests. */
  const inflight = new Map<string, Promise<unknown>>();
  function load<T>(
    field: 'databases' | 'tables' | 'details' | 'schemas',
    k: string,
    refresh: boolean | undefined,
    fetcher: () => Promise<T>,
  ): Promise<T | undefined> {
    const current = (get()[field] as Record<string, Load<T>>)[k];
    if (!refresh && current?.status === 'ready') return Promise.resolve(current.data);
    const flightKey = `${field}:${k}`;
    if (!refresh && inflight.has(flightKey)) return inflight.get(flightKey) as Promise<T | undefined>;
    set((s) => ({ [field]: { ...(s[field] as object), [k]: { status: 'loading', data: current?.data } } }) as Partial<Store>);
    const p = fetcher()
      .then((data) => {
        set((s) => ({ [field]: { ...(s[field] as object), [k]: { status: 'ready', data } } }) as Partial<Store>);
        return data;
      })
      .catch((err: unknown) => {
        set((s) => ({ [field]: { ...(s[field] as object), [k]: { status: 'error', error: errorMessage(err) } } }) as Partial<Store>);
        return undefined;
      })
      .finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, p);
    return p;
  }

  const clearConnectionCaches = (connectionId: string) => {
    const prefix = key(connectionId, '');
    const strip = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== connectionId && !k.startsWith(prefix)));
    set((s) => ({ databases: strip(s.databases), tables: strip(s.tables), details: strip(s.details), schemas: strip(s.schemas) }));
  };

  return {
    ready: false,
    connections: [],
    settings: DEFAULT_SETTINGS,
    databases: {},
    tables: {},
    details: {},
    schemas: {},
    expanded: {},
    tableLimit: {},
    positions: {},
    showSystemDatabases: false,
    selection: null,
    tabs: FIXED_TABS,
    activeTab: 'graph',
    dataTabs: {},
    schemaFocus: { depth: 1, compact: false, hideIsolated: false },
    builder: { model: emptyModel(), running: false, notes: [] },
    sql: { text: '', running: false, results: [], cancelled: false, activeResult: 0, mode: 'single', targets: { databases: [] }, concurrency: 1, multiStarting: false },
    search: {
      mode: 'metadata',
      term: '',
      runToken: 0,
      connectionIds: [],
      data: { tables: [], match: 'contains', perTableLimit: 20, running: false, done: 0, total: 0, results: [] },
    },
    compare: { level: 'schema', source: {}, target: {}, options: DEFAULT_COMPARE_OPTIONS },
    logs: [],
    toasts: [],
    connectionForm: { open: false },
    savedQueries: [],
    historyVersion: 0,

    set: (patch) => set(patch as never),

    toast: (kind, message) => {
      const id = uid('t');
      set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    setConnections: (connections) => {
      const prev = get().connections;
      for (const c of connections) {
        const before = prev.find((p) => p.config.id === c.config.id);
        if (before?.status === 'connected' && c.status !== 'connected') clearConnectionCaches(c.config.id);
      }
      const active = get().activeConnectionId;
      set({
        connections,
        activeConnectionId: active && connections.some((c) => c.config.id === active) ? active : connections[0]?.config.id,
      });
    },

    setActiveConnection: (id) => set({ activeConnectionId: id }),

    connect: async (id) => {
      try {
        await rpc({ type: 'connect', connectionId: id });
        get().toggleExpanded(`conn:${id}`, true);
        await get().loadDatabases(id);
        return true;
      } catch (err) {
        get().toast('error', errorMessage(err));
        return false;
      }
    },

    disconnect: async (id) => {
      try {
        await rpc({ type: 'disconnect', connectionId: id });
        clearConnectionCaches(id);
      } catch (err) {
        get().toast('error', errorMessage(err));
      }
    },

    loadDatabases: (connectionId, refresh) => load('databases', connectionId, refresh, () => rpc({ type: 'listDatabases', connectionId, refresh })),
    loadTables: (connectionId, database, refresh) => load('tables', key(connectionId, database), refresh, () => rpc({ type: 'listTables', connectionId, database, refresh })),
    loadDetails: (connectionId, database, table, refresh) =>
      load('details', key(connectionId, database, table), refresh, () => rpc({ type: 'getTableDetails', connectionId, database, table, refresh })),
    loadSchema: (connectionId, database, refresh) => load('schemas', key(connectionId, database), refresh, () => rpc({ type: 'getDatabaseSchema', connectionId, database, refresh })),

    refreshConnection: async (connectionId) => {
      clearConnectionCaches(connectionId);
      const dbs = await get().loadDatabases(connectionId, true);
      const expanded = get().expanded;
      await Promise.all((dbs ?? []).filter((d) => expanded[`db:${key(connectionId, d.name)}`]).map((d) => get().loadTables(connectionId, d.name)));
      get().toast('info', 'Metadata refreshed');
    },

    toggleExpanded: (id, value) => set((s) => ({ expanded: { ...s.expanded, [id]: value ?? !s.expanded[id] } })),

    select: (selection) => {
      set({ selection });
      if (selection && 'connectionId' in selection) set({ activeConnectionId: selection.connectionId });
      if (selection?.kind === 'table' || selection?.kind === 'column') void get().loadDetails(selection.connectionId, selection.database, selection.table);
    },

    openTab: (tab) => set({ activeTab: tab }),

    openTable: (connectionId, database, table, init) => {
      const id = dataTabId(connectionId, database, table);
      set((s) => {
        const exists = s.tabs.some((t) => t.id === id);
        const settings = s.settings;
        const state: DataTabState = s.dataTabs[id] ?? {
          draftFilter: emptyGroup(),
          filter: emptyGroup(),
          sort: [],
          offset: 0,
          pageSize: settings.pageSize,
          loading: false,
          showFilters: false,
          showSql: false,
          editMode: false,
          changes: {},
          deletes: [],
        };
        return {
          tabs: exists ? s.tabs : [...s.tabs, { id, kind: 'data', connectionId, database, table }],
          activeTab: id,
          dataTabs: { ...s.dataTabs, [id]: { ...state, ...init, ...(init?.filter ? { page: undefined, offset: 0 } : {}) } },
        };
      });
    },

    closeTab: (id) =>
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx === -1 || s.tabs[idx]!.kind !== 'data') return {};
        const tabs = s.tabs.filter((t) => t.id !== id);
        const { [id]: _removed, ...rest } = s.dataTabs;
        return { tabs, dataTabs: rest, activeTab: s.activeTab === id ? (tabs[idx - 1]?.id ?? 'graph') : s.activeTab };
      }),

    updateDataTab: (id, patch) =>
      set((s) => {
        const cur = s.dataTabs[id];
        if (!cur) return {};
        const p = typeof patch === 'function' ? patch(cur) : patch;
        return { dataTabs: { ...s.dataTabs, [id]: { ...cur, ...p } } };
      }),

    updateBuilder: (patch) => set((s) => ({ builder: { ...s.builder, ...(typeof patch === 'function' ? patch(s.builder) : patch) } })),
    updateSql: (patch) => set((s) => ({ sql: { ...s.sql, ...(typeof patch === 'function' ? patch(s.sql) : patch) } })),
    updateSearch: (patch) => set((s) => ({ search: { ...s.search, ...(typeof patch === 'function' ? patch(s.search) : patch) } })),
    updateCompare: (patch) => set((s) => ({ compare: { ...s.compare, ...(typeof patch === 'function' ? patch(s.compare) : patch) } })),

    addLog: (entry) => set((s) => ({ logs: [...s.logs.slice(-499), entry] })),

    searchMetadata: (term) => {
      set((s) => ({ search: { ...s.search, mode: 'metadata', term, runToken: s.search.runToken + 1 }, activeTab: 'search' }));
    },

    openSqlWith: (sql, connectionId, database) => {
      set((s) => ({
        sql: { ...s.sql, text: sql, savedQueryId: undefined, connectionId: connectionId ?? s.sql.connectionId ?? s.activeConnectionId, database: database ?? s.sql.database },
        activeTab: 'sql',
      }));
    },

    beginMultiRun: (runId, connectionId, databases) => {
      const previous = get().sql.multiRun;
      const order = [...new Set(databases)];
      set((s) => ({
        sql: {
          ...s.sql,
          multiRun: {
            summary: {
              runId,
              connectionId,
              statements: [],
              total: order.length,
              attempt: 1,
              running: true,
              cancelled: false,
              startedAt: Date.now(),
              counts: { succeeded: 0, failed: 0, partial: 0, not_run: 0 },
              errorGroups: [],
            },
            order,
            targets: Object.fromEntries(order.map((database) => [database, { database, status: 'pending', statements: [], durationMs: 0, attempts: [] }])),
            results: {},
          },
        },
      }));
      return previous;
    },

    applyMultiRunSnapshot: (snapshot) =>
      set((s) => {
        const prev = s.sql.multiRun?.summary.runId === snapshot.summary.runId ? s.sql.multiRun : undefined;
        const newer = (t: MultiRunTarget) => {
          const seen = prev?.targets[t.database];
          return seen && (seen.attempts.length > t.attempts.length || (seen.attempts.length === t.attempts.length && seen.status === 'running' && t.status === 'pending')) ? seen : t;
        };
        // A finished event for this attempt may already have arrived; it is newer than the snapshot.
        const keepSummary = prev && (prev.summary.attempt > snapshot.summary.attempt || (prev.summary.attempt === snapshot.summary.attempt && prev.summary.statements.length > 0 && !prev.summary.running));
        return {
          sql: {
            ...s.sql,
            multiRun: {
              summary: keepSummary ? prev.summary : snapshot.summary,
              order: snapshot.targets.map((t) => t.database),
              targets: Object.fromEntries(snapshot.targets.map((t) => [t.database, newer(t)])),
              results: prev?.results ?? {},
            },
          },
        };
      }),
  };
});

export const connectionById = (id: string | undefined) => useStore.getState().connections.find((c) => c.config.id === id);
