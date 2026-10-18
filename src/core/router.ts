import type {
  BuiltQuery,
  ConnectionSummary,
  DataSearchProgress,
  DataSearchRequest,
  HistoryEntry,
  LogEntry,
  MetadataHit,
  MultiRunPreview,
  MultiRunSnapshot,
  MultiRunTarget,
  QueryResult,
  SqlStatementResult,
  TableDetails,
} from '../shared/model';
import type { ConnectionInput, HostEvent, HostToWebview, Request, RequestOf, ResponseMap } from '../shared/protocol';
import { envelopeSchema, requestSchema } from '../shared/protocol';
import { DeepDiveError, detailedErrorCode, errorCode, validationError } from './errors';
import type { DbDriver } from './drivers/driver';
import type { ConnectionManager } from './services/connectionManager';
import type { MetadataService } from './services/metadataService';
import { finalStatus, newTarget, resumeIndex, snapshotTarget, summarize, type MultiRunState } from './services/multiRun';
import type { QueryLibrary } from './services/queryLibrary';
import { QueryRegistry } from './services/queryRegistry';
import type { Settings } from './settings';
import { toUiSettings } from './settings';
import { classifyStatement } from './sql/classify';
import { buildEditStatements } from './sql/edits';
import { quoteIdent } from './sql/identifiers';
import { splitStatements } from './sql/lexer';
import { inlineParams } from './sql/literals';
import { compileQueryModel } from './sql/queryModel';
import { qualifiedDatabaseRefs } from './sql/references';
import { buildDataSearchQuery } from './sql/search';
import { buildCountQuery, buildTableQuery } from './sql/tableQuery';

/** Everything the router needs from its host (VS Code in production, a fake in tests/dev server). */
export interface HostBridge {
  settings(): Settings;
  emit(event: HostEvent): void;
  /** Must show a modal confirmation that the user explicitly accepts. */
  confirm(options: { title: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /** Second confirmation step for risky operations: the user must type `expected` exactly. */
  confirmTyped(options: { title: string; prompt: string; expected: string }): Promise<boolean>;
  copyText(text: string): Promise<void>;
  openSqlDocument(sql: string): Promise<void>;
  output(line: string): void;
}

const DEMO_COLORS = { acme: '#22c55e', lake: '#a855f7' } as const;
const PREVIEW_STATEMENTS = 8;
const PREVIEW_DATABASES = 10;
/** Finished multi-database runs kept in memory so they can be retried. */
const MAX_KEPT_RUNS = 5;

const nameList = (names: readonly string[], max = 5) =>
  `${names.slice(0, max).map((n) => `"${n}"`).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`;

type Handler<T extends Request['type']> = (req: RequestOf<T>) => Promise<ResponseMap[T]>;

export class MessageRouter {
  readonly queries = new QueryRegistry();
  private readonly searches = new Map<string, AbortController>();
  private readonly multiRuns = new Map<string, MultiRunState>();
  private logSeq = 0;
  private readonly disposeListener: () => void;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly metadata: MetadataService,
    private readonly bridge: HostBridge,
    private readonly library: QueryLibrary,
  ) {
    this.disposeListener = connections.onDidChange(() => this.bridge.emit({ type: 'connectionsChanged', connections: connections.list() }));
  }

  dispose(): void {
    this.disposeListener();
    this.queries.cancelAll();
    for (const s of this.searches.values()) s.abort();
    this.searches.clear();
  }

  /** Validates and dispatches one raw message from the webview. Returns the response to post back. */
  async handle(raw: unknown): Promise<HostToWebview | null> {
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success) {
      this.bridge.output('Ignored malformed message from webview');
      return null;
    }
    const { id } = envelope.data;
    const parsed = requestSchema.safeParse(envelope.data.payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
      return { kind: 'response', id, ok: false, error: { message: `Invalid request${where}: ${issue?.message ?? 'unknown'}`, code: 'VALIDATION' } };
    }
    try {
      const result = await this.dispatch(parsed.data);
      return { kind: 'response', id, ok: true, result };
    } catch (err) {
      return { kind: 'response', id, ok: false, error: { message: this.connections.redact(err), code: errorCode(err) ?? 'DB_ERROR' } };
    }
  }

  private dispatch(req: Request): Promise<unknown> {
    const handler = (this.handlers as Record<string, Handler<Request['type']>>)[req.type];
    if (!handler) throw validationError(`Unsupported request ${req.type}`);
    return handler(req);
  }

  private log(level: LogEntry['level'], message: string, extra: Partial<LogEntry> = {}): void {
    const entry: LogEntry = { id: `l${++this.logSeq}`, time: Date.now(), level, message, ...extra };
    this.bridge.emit({ type: 'log', entry });
    const conn = extra.connectionId ? this.safeName(extra.connectionId) : '';
    this.bridge.output(`[${level}]${conn ? ` [${conn}]` : ''} ${message}${extra.sql ? `\n    ${extra.sql.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`);
  }

  private safeName(connectionId: string): string {
    try {
      return this.connections.getConfig(connectionId).name;
    } catch {
      return connectionId;
    }
  }

  private driver(connectionId: string): DbDriver {
    return this.connections.driver(connectionId);
  }

  private queryOptions(signal?: AbortSignal, overrides: { maxRows?: number; database?: string; readOnly?: boolean } = {}) {
    const s = this.bridge.settings();
    return { timeoutMs: s.queryTimeoutMs, maxRows: overrides.maxRows ?? s.maxResultRows, signal, database: overrides.database, readOnly: overrides.readOnly };
  }

  private async loadModelDetails(connectionId: string, tables: { database: string; table: string }[]) {
    const map = new Map<string, TableDetails>();
    await Promise.all(
      tables.map(async (t) => {
        map.set(`${t.database}\u0000${t.table}`, await this.metadata.tableDetails(connectionId, t.database, t.table));
      }),
    );
    return (database: string, table: string) => {
      const d = map.get(`${database}\u0000${table}`);
      if (!d) throw new DeepDiveError(`Table ${database}.${table} was not found`, 'NOT_FOUND');
      return d;
    };
  }

  private async buildModel(connectionId: string, model: RequestOf<'buildQuery'>['model']): Promise<BuiltQuery> {
    const lookup = await this.loadModelDetails(connectionId, model.tables);
    const compiled = compileQueryModel(model, lookup);
    return { ...compiled, displaySql: inlineParams(compiled.sql, compiled.params, this.driver(connectionId).dialect) };
  }

  private async confirmWrites(connectionId: string, statements: string[], action: string): Promise<void> {
    const config = this.connections.getConfig(connectionId);
    if (config.readOnly) {
      throw new DeepDiveError(
        `"${config.name}" is read-only. Edit the connection and turn off "Read-only" to run ${action}.`,
        'READ_ONLY',
      );
    }
    const preview = statements
      .slice(0, PREVIEW_STATEMENTS)
      .map((s) => (s.length > 300 ? `${s.slice(0, 300)}…` : s))
      .join('\n\n');
    const more = statements.length > PREVIEW_STATEMENTS ? `\n\n…and ${statements.length - PREVIEW_STATEMENTS} more` : '';
    const env = config.environment === 'production' ? ' ⚠ PRODUCTION' : '';
    const ok = await this.bridge.confirm({
      title: `Run ${statements.length} write statement(s) on "${config.name}"${env}?`,
      detail: `${preview}${more}\n\nThese statements can modify data or schema. Changes are committed by MySQL when they succeed.`,
      confirmLabel: 'Execute',
    });
    if (!ok) throw new DeepDiveError('Cancelled — nothing was executed.', 'DECLINED');
  }

  private readonly handlers: { [K in Request['type']]: Handler<K> } = {
    init: async () => ({ connections: this.connections.list(), settings: toUiSettings(this.bridge.settings()), savedQueries: this.library.listSaved() }),

    listConnections: async () => this.connections.list(),

    saveConnection: async (req) => {
      const summary = await this.connections.save(req.config, req.password);
      this.metadata.invalidate(summary.config.id);
      this.log('info', `Saved connection "${summary.config.name}"`);
      return summary;
    },

    deleteConnection: async (req) => {
      const config = this.connections.getConfig(req.connectionId);
      const ok = await this.bridge.confirm({
        title: `Remove connection "${config.name}"?`,
        detail: 'The saved settings and stored password will be deleted. Databases are not affected.',
        confirmLabel: 'Remove',
      });
      if (!ok) return false;
      this.queries.cancelConnection(req.connectionId);
      await this.connections.remove(req.connectionId);
      this.metadata.invalidate(req.connectionId);
      this.log('info', `Removed connection "${config.name}"`);
      return true;
    },

    testConnection: async (req) => {
      const serverVersion = await this.connections.test(req.config, req.password);
      return { ok: true, serverVersion };
    },

    connect: async (req) => {
      try {
        const s = await this.connections.connect(req.connectionId);
        this.log('info', `Connected (${s.serverVersion ?? 'unknown version'})`, { connectionId: req.connectionId });
        return s;
      } catch (err) {
        this.log('error', `Connection failed: ${this.connections.redact(err)}`, { connectionId: req.connectionId });
        throw err;
      }
    },

    disconnect: async (req) => {
      this.queries.cancelConnection(req.connectionId);
      this.metadata.invalidate(req.connectionId);
      const s = await this.connections.disconnect(req.connectionId);
      this.log('info', 'Disconnected', { connectionId: req.connectionId });
      return s;
    },

    addDemoConnections: async () => {
      const out: ConnectionSummary[] = [];
      const existing = this.connections.list();
      const defs: { dataset: 'acme' | 'lake'; name: string }[] = [
        { dataset: 'acme', name: 'Acme Shop (demo)' },
        { dataset: 'lake', name: 'Data Lake (demo)' },
      ];
      for (const d of defs) {
        const found = existing.find((c) => c.config.kind === 'demo' && c.config.demoDataset === d.dataset);
        if (found) {
          out.push(found);
          continue;
        }
        const input: ConnectionInput = {
          name: d.name,
          color: DEMO_COLORS[d.dataset],
          kind: 'demo',
          demoDataset: d.dataset,
          environment: 'development',
          host: 'demo.local',
          port: 3306,
          user: 'demo',
          readOnly: false,
          tls: { mode: 'disabled' },
          connectTimeoutMs: 10_000,
        };
        out.push(await this.connections.save(input, null));
      }
      return out;
    },

    listDatabases: async (req) => this.metadata.databases(req.connectionId, req.refresh),

    listTables: async (req) => this.metadata.tables(req.connectionId, req.database, req.refresh),

    getTableDetails: async (req) => this.metadata.tableDetails(req.connectionId, req.database, req.table, req.refresh),

    getDatabaseSchema: async (req) => this.metadata.schema(req.connectionId, req.database, req.refresh),

    fetchTableRows: async (req) => {
      const details = await this.metadata.tableDetails(req.connectionId, req.query.database, req.query.table);
      const built = buildTableQuery(req.query, details);
      const driver = this.driver(req.connectionId);
      const result = await this.queries.run(req.queryId, req.connectionId, (signal) =>
        driver.query(built.sql, built.params, this.queryOptions(signal, { maxRows: req.query.limit + 1, readOnly: true })),
      );
      const hasMore = result.rows.length > req.query.limit;
      const displayParams = built.params.slice(0, -2).concat([req.query.limit, req.query.offset]);
      this.log('info', `Browsed ${req.query.database}.${req.query.table}`, {
        connectionId: req.connectionId,
        sql: built.sql,
        durationMs: result.durationMs,
        rows: Math.min(result.rows.length, req.query.limit),
      });
      return {
        sql: built.sql,
        displaySql: inlineParams(built.sql, displayParams, driver.dialect),
        columns: result.columns.length ? result.columns : built.columns.map((name) => ({ name })),
        hiddenColumns: built.hiddenColumns,
        rows: hasMore ? result.rows.slice(0, req.query.limit) : result.rows,
        hasMore,
        offset: req.query.offset,
        durationMs: result.durationMs,
      };
    },

    countRows: async (req) => {
      const details = await this.metadata.tableDetails(req.connectionId, req.database, req.table);
      const built = buildCountQuery(details, req.filter);
      const driver = this.driver(req.connectionId);
      const result = await this.queries.run(req.queryId, req.connectionId, (signal) =>
        driver.query(built.sql, built.params, this.queryOptions(signal, { maxRows: 1, readOnly: true })),
      );
      this.log('info', `Counted rows in ${req.database}.${req.table}`, { connectionId: req.connectionId, sql: built.sql, durationMs: result.durationMs });
      return { count: Number(result.rows[0]?.[0] ?? 0), sql: inlineParams(built.sql, built.params, driver.dialect) };
    },

    buildQuery: async (req) => this.buildModel(req.connectionId, req.model),

    runQueryModel: async (req) => {
      const built = await this.buildModel(req.connectionId, req.model);
      const driver = this.driver(req.connectionId);
      try {
        const result = await this.queries.run(req.queryId, req.connectionId, (signal) => driver.query(built.sql, built.params, this.queryOptions(signal, { readOnly: true })));
        this.log('info', 'Ran visual query', { connectionId: req.connectionId, sql: built.sql, durationMs: result.durationMs, rows: result.rows.length });
        return { built, statement: { sql: built.displaySql, result } };
      } catch (err) {
        const message = this.connections.redact(err);
        this.log('error', `Visual query failed: ${message}`, { connectionId: req.connectionId, sql: built.sql });
        return { built, statement: { sql: built.displaySql, error: message } };
      }
    },

    runSql: async (req) => {
      const statements = splitStatements(req.sql);
      if (statements.length === 0) throw validationError('Nothing to run');
      if (statements.length > 100) throw validationError('Too many statements in one run (max 100)');
      const classified = statements.map((sql) => ({ sql, c: classifyStatement(sql) }));
      const writes = classified.filter((s) => !s.c.readOnly);
      if (writes.length > 0) await this.confirmWrites(req.connectionId, writes.map((w) => w.sql), 'write statements');
      const driver = this.driver(req.connectionId);
      let database = req.database;
      const results: SqlStatementResult[] = [];
      let cancelled = false;
      await this.queries.run(req.queryId, req.connectionId, async (signal) => {
        for (const { sql, c } of classified) {
          if (signal.aborted) {
            cancelled = true;
            break;
          }
          if (c.keyword === 'USE') {
            // Pooled connections make a session-level USE meaningless; apply it to the rest of this run instead.
            const name = /^\s*USE\s+(`(?:[^`]|``)+`|\S+?)\s*;?\s*$/i.exec(sql)?.[1]?.replace(/^`|`$/g, '').replace(/``/g, '`');
            if (!name) {
              results.push({ sql, error: 'Could not parse USE statement' });
              break;
            }
            const dbs = await this.metadata.databases(req.connectionId);
            if (!dbs.some((d) => d.name === name)) {
              results.push({ sql, error: `Unknown database ${quoteIdent(name)}` });
              break;
            }
            database = name;
            results.push({ sql, result: { kind: 'ok', columns: [], rows: [], truncated: false, affectedRows: 0, durationMs: 0 } });
            continue;
          }
          try {
            const result = await driver.query(sql, [], this.queryOptions(signal, { database, readOnly: c.readOnly }));
            results.push({ sql, result });
            const summary = result.kind === 'rows' ? `${result.rows.length} row(s)${result.truncated ? ' (truncated)' : ''}` : `${result.affectedRows ?? 0} row(s) affected — committed`;
            this.log(c.readOnly ? 'info' : 'warn', `${c.readOnly ? 'Query' : 'Write'}: ${summary}`, {
              connectionId: req.connectionId,
              sql,
              durationMs: result.durationMs,
              rows: result.rows.length,
            });
            if (!c.readOnly) this.metadata.invalidate(req.connectionId);
          } catch (err) {
            const message = this.connections.redact(err);
            if (errorCode(err) === 'CANCELLED') cancelled = true;
            results.push({ sql, error: message, errorCode: detailedErrorCode(err) });
            this.log('error', message, { connectionId: req.connectionId, sql });
            break;
          }
        }
      });
      const lastRows = results.filter((r) => r.result?.kind === 'rows').pop();
      const firstError = results.find((r) => r.error);
      await this.recordHistory({
        sql: req.sql,
        connectionId: req.connectionId,
        database: req.database,
        status: cancelled ? 'cancelled' : firstError ? 'error' : 'ok',
        durationMs: results.reduce((sum, r) => sum + (r.result?.durationMs ?? 0), 0),
        rowCount: lastRows?.result?.rows.length,
        error: firstError?.error,
      });
      if (req.savedQueryId) {
        await this.library.markRun(req.savedQueryId);
        this.emitSavedQueries();
      }
      return { statements: results, cancelled };
    },

    listSavedQueries: async () => this.library.listSaved(),

    saveQuery: async (req) => {
      const saved = await this.library.save(req.query);
      this.emitSavedQueries();
      this.log('info', `Saved query "${saved.name}"`);
      return saved;
    },

    deleteSavedQuery: async (req) => {
      const q = this.library.listSaved().find((x) => x.id === req.id);
      if (!q) return false;
      const ok = await this.bridge.confirm({ title: `Delete saved query "${q.name}"?`, detail: 'The saved query is removed from DeepDive. This cannot be undone.', confirmLabel: 'Delete' });
      if (!ok) return false;
      await this.library.deleteSaved(req.id);
      this.emitSavedQueries();
      return true;
    },

    listHistory: async (req) => this.library.listHistory(req),

    deleteHistoryEntry: async (req) => {
      const ok = await this.library.deleteHistoryEntry(req.id);
      if (ok) this.bridge.emit({ type: 'historyChanged' });
      return ok;
    },

    clearHistory: async () => {
      const ok = await this.bridge.confirm({ title: 'Clear the query history?', detail: 'All history entries are deleted. Saved queries are kept.', confirmLabel: 'Clear history' });
      if (!ok) return false;
      await this.library.clearHistory();
      this.bridge.emit({ type: 'historyChanged' });
      return true;
    },

    locateTable: async (req) => this.driver(req.connectionId).locateTable(req.table, req.column),

    previewMultiRun: async (req) => (await this.analyzeMultiRun(req.connectionId, req.sql, req.databases)).preview,

    runSqlMulti: async (req) => {
      if (this.multiRuns.has(req.runId)) throw validationError('A run with this id already exists');
      const analysis = await this.analyzeMultiRun(req.connectionId, req.sql, req.databases);
      if (analysis.preview.problems.length) throw validationError(analysis.preview.problems.join('\n'));
      const statements = analysis.preview.statements;
      await this.confirmMultiRun(
        req.connectionId,
        statements,
        analysis.databases.map((database) => ({ database, from: 0 })),
        analysis.preview.warnings,
      );
      const run: MultiRunState = {
        runId: req.runId,
        connectionId: req.connectionId,
        statements: statements.map((st) => st.sql),
        readOnly: statements.map((st) => st.readOnly),
        concurrency: Math.min(req.concurrency, this.bridge.settings().poolSize),
        targets: analysis.databases.map((d) => newTarget(d, statements.length)),
        attempt: 1,
        running: true,
        cancelled: false,
        startedAt: Date.now(),
      };
      this.keepRun(run);
      this.log(analysis.preview.writes ? 'warn' : 'info', `Running ${statements.length} statement(s) on ${run.targets.length} database(s)`, { connectionId: req.connectionId, sql: req.sql });
      this.startAttempt(
        run,
        run.targets.map((_, i) => i),
        req.sql,
      );
      return this.multiRunSnapshot(run);
    },

    retryMultiRun: async (req) => {
      const run = this.multiRuns.get(req.runId);
      if (!run) throw new DeepDiveError('This run is no longer available. Start a new run instead.', 'NOT_FOUND');
      if (run.running) throw validationError('The run is still in progress');
      this.driver(run.connectionId);
      if (req.mode === 'database' && !req.database) throw validationError('Choose the database to retry');
      const pick = (t: MultiRunTarget) =>
        req.mode === 'failed' ? t.status === 'failed' || t.status === 'not_run' : req.mode === 'partial' ? t.status === 'partial' : t.database === req.database && t.status !== 'succeeded';
      const indices = run.targets.flatMap((t, i) => (pick(t) ? [i] : []));
      if (indices.length === 0) throw validationError('Nothing to retry');
      await this.confirmMultiRun(
        run.connectionId,
        run.statements.map((sql, i) => ({ sql, readOnly: run.readOnly[i]! })),
        indices.map((i) => ({ database: run.targets[i]!.database, from: Math.max(0, resumeIndex(run.targets[i]!)) })),
        [],
      );
      // Another retry may have been confirmed while this confirmation was open.
      if (run.running) throw validationError('The run is still in progress');
      run.attempt += 1;
      this.startAttempt(run, indices);
      return this.multiRunSnapshot(run);
    },

    cancelMultiRun: async (req) => {
      const run = this.multiRuns.get(req.runId);
      return run ? this.queries.cancel(`${run.runId}#${run.attempt}`) : false;
    },

    cancelQuery: async (req) => this.queries.cancel(req.queryId),

    applyEdits: async (req) => {
      const details = await this.metadata.tableDetails(req.connectionId, req.database, req.table, true);
      const driver = this.driver(req.connectionId);
      const statements = buildEditStatements(details, req.updates, req.deletes, driver.dialect);
      if (statements.length === 0) return { committed: false, statements: 0, affectedRows: 0, message: 'No changes to save.' };
      await this.confirmWrites(
        req.connectionId,
        statements.map((s) => inlineParams(s.sql, s.params, driver.dialect)),
        'edits',
      );
      const affected = await driver.transaction(statements, this.queryOptions(), (i, n) => {
        if (n !== 1) {
          throw new DeepDiveError(
            `Statement ${i + 1} affected ${n} rows instead of 1 (the row may have been changed or deleted by someone else). All changes were rolled back.`,
            'DB_ERROR',
          );
        }
      });
      const total = affected.reduce((a, b) => a + b, 0);
      this.metadata.invalidate(req.connectionId, req.database);
      const message = `Committed ${statements.length} statement(s), ${total} row(s) affected in ${req.database}.${req.table}.`;
      this.log('warn', message, { connectionId: req.connectionId });
      return { committed: true, statements: statements.length, affectedRows: total, message };
    },

    searchMetadata: async (req) => {
      const ids = (req.connectionIds ?? this.connections.list().map((c) => c.config.id)).filter((id) => this.connections.isConnected(id));
      const hits: MetadataHit[] = [];
      const errors: string[] = [];
      let limited = false;
      await Promise.all(
        ids.map(async (id) => {
          try {
            const found = await this.driver(id).searchMetadata(req.term, req.limit);
            const counts = { database: 0, table: 0, column: 0 };
            for (const h of found) counts[h.kind]++;
            if (Object.values(counts).some((n) => n >= req.limit)) limited = true;
            hits.push(...found.map((h) => ({ ...h, connectionId: id })));
          } catch (err) {
            errors.push(`${this.safeName(id)}: ${this.connections.redact(err)}`);
          }
        }),
      );
      return { hits, limited, errors };
    },

    searchData: async (req) => {
      const r = req.request;
      const max = this.bridge.settings().maxTablesPerDataSearch;
      if (r.tables.length > max) throw validationError(`A data search may scan at most ${max} tables (setting deepdive.search.maxTablesPerDataSearch)`);
      if (this.searches.has(r.searchId)) throw validationError('Search already running');
      this.driver(r.connectionId);
      const controller = new AbortController();
      this.searches.set(r.searchId, controller);
      void this.runDataSearch(r, controller).finally(() => this.searches.delete(r.searchId));
      return { started: true };
    },

    cancelSearch: async (req) => {
      const s = this.searches.get(req.searchId);
      s?.abort();
      return Boolean(s);
    },

    copyText: async (req) => {
      await this.bridge.copyText(req.text);
      return true;
    },

    openSqlDocument: async (req) => {
      await this.bridge.openSqlDocument(req.sql);
      return true;
    },
  };

  private emitSavedQueries(): void {
    this.bridge.emit({ type: 'savedQueriesChanged', savedQueries: this.library.listSaved() });
  }

  /** History is a convenience: a storage failure is reported in the output channel but never fails the run. */
  private async recordHistory(entry: Omit<HistoryEntry, 'id' | 'runs' | 'executedAt'>): Promise<void> {
    const s = this.bridge.settings();
    if (!s.historyEnabled) return;
    try {
      if (await this.library.record(entry, s.historyMaxEntries)) this.bridge.emit({ type: 'historyChanged' });
    } catch (err) {
      this.bridge.output(`Could not save query history: ${this.connections.redact(err)}`);
    }
  }

  /** Validates a script and target list for a run on multiple databases. */
  private async analyzeMultiRun(connectionId: string, sql: string, requested: string[]): Promise<{ databases: string[]; preview: MultiRunPreview }> {
    const config = this.connections.getConfig(connectionId);
    this.driver(connectionId);
    const problems: string[] = [];
    const warnings: string[] = [];
    const statements = splitStatements(sql).map((st) => {
      const c = classifyStatement(st);
      return { sql: st, readOnly: c.readOnly, keyword: c.keyword };
    });
    if (statements.length === 0) problems.push('Nothing to run');
    if (statements.length > 100) problems.push('Too many statements in one run (max 100)');
    if (statements.some((st) => st.keyword === 'USE')) problems.push('USE is not allowed when running on multiple databases: each database is selected automatically.');
    const writes = statements.filter((st) => !st.readOnly).length;
    if (writes > 0 && config.readOnly) problems.push(`"${config.name}" is read-only. Edit the connection and turn off "Read-only" to run write statements.`);

    const databases = [...new Set(requested)];
    const max = this.bridge.settings().multiRunMaxDatabases;
    if (databases.length > max) problems.push(`A run may target at most ${max} databases (setting deepdive.multiRun.maxDatabases)`);
    let known = await this.metadata.databases(connectionId);
    if (databases.some((d) => !known.some((k) => k.name === d))) known = await this.metadata.databases(connectionId, true);
    const unknown = databases.filter((d) => !known.some((k) => k.name === d));
    if (unknown.length) problems.push(`Unknown database(s): ${nameList(unknown)}`);
    const system = databases.filter((d) => known.find((k) => k.name === d)?.isSystem);
    if (system.length) warnings.push(`System database(s) selected: ${nameList(system)}.`);
    const refs = qualifiedDatabaseRefs(sql, known.map((k) => k.name));
    if (refs.length) {
      warnings.push(`The script names database ${nameList(refs)} explicitly. Qualified names ignore the target database, so every iteration would use the same objects.`);
    }
    return { databases, preview: { statements, writes, problems, warnings } };
  }

  /**
   * One confirmation for a whole multi-database run. Required when anything writes or when there are
   * warnings; production connections additionally require typing the number of databases.
   */
  private async confirmMultiRun(
    connectionId: string,
    statements: readonly { sql: string; readOnly: boolean }[],
    plan: readonly { database: string; from: number }[],
    warnings: readonly string[],
  ): Promise<void> {
    const config = this.connections.getConfig(connectionId);
    const firstFrom = Math.min(...plan.map((p) => p.from));
    const toRun = statements.map((st, i) => ({ ...st, n: i + 1 })).slice(firstFrom);
    const writes = toRun.filter((st) => !st.readOnly).length;
    if (writes === 0 && warnings.length === 0) return;
    if (writes > 0 && config.readOnly) {
      throw new DeepDiveError(`"${config.name}" is read-only. Edit the connection and turn off "Read-only" to run write statements.`, 'READ_ONLY');
    }
    const production = config.environment === 'production';
    const env = production ? ' ⚠ PRODUCTION' : '';
    const dbs = plan
      .slice(0, PREVIEW_DATABASES)
      .map((p) => (p.from > 0 ? `${p.database} (from statement #${p.from + 1})` : p.database))
      .join(', ');
    const moreDbs = plan.length > PREVIEW_DATABASES ? ` … and ${plan.length - PREVIEW_DATABASES} more` : '';
    const preview = toRun
      .slice(0, PREVIEW_STATEMENTS)
      .map((st) => `#${st.n} ${st.sql.length > 300 ? `${st.sql.slice(0, 300)}…` : st.sql}`)
      .join('\n\n');
    const moreSt = toRun.length > PREVIEW_STATEMENTS ? `\n\n…and ${toRun.length - PREVIEW_STATEMENTS} more` : '';
    const warningText = warnings.map((w) => `⚠ ${w}`).join('\n');
    const ok = await this.bridge.confirm({
      title:
        writes > 0
          ? `Run ${writes} write statement(s) on ${plan.length} database(s) of "${config.name}"${env}?`
          : `Run on ${plan.length} database(s) of "${config.name}"${env}?`,
      detail: [
        warningText,
        `Databases: ${dbs}${moreDbs}`,
        `${preview}${moreSt}`,
        'Each database runs on its own: a database that fails is skipped and the run continues. Nothing is rolled back across databases, and MySQL commits schema changes (DDL) immediately.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      confirmLabel: 'Execute',
    });
    if (!ok) throw new DeepDiveError('Cancelled — nothing was executed.', 'DECLINED');
    if (writes > 0 && production) {
      const typed = await this.bridge.confirmTyped({
        title: `Confirm writes on ${plan.length} production database(s) of "${config.name}"`,
        prompt: `Type ${plan.length} to confirm`,
        expected: String(plan.length),
      });
      if (!typed) throw new DeepDiveError('Cancelled — nothing was executed.', 'DECLINED');
    }
  }

  private keepRun(run: MultiRunState): void {
    this.multiRuns.set(run.runId, run);
    for (const [runId, r] of this.multiRuns) {
      if (this.multiRuns.size <= MAX_KEPT_RUNS) break;
      if (!r.running) this.multiRuns.delete(runId);
    }
  }

  private multiRunSnapshot(run: MultiRunState): MultiRunSnapshot {
    return { summary: summarize(run), targets: run.targets.map(snapshotTarget) };
  }

  private startAttempt(run: MultiRunState, indices: number[], historySql?: string): void {
    for (const i of indices) run.targets[i]!.status = 'pending';
    run.startedAt = Date.now();
    run.running = true;
    run.cancelled = false;
    run.finishedAt = undefined;
    // Deferred so the response carrying the initial snapshot reaches the webview before any progress event.
    setTimeout(() => void this.executeAttempt(run, indices, historySql), 0);
  }

  private settleTarget(t: MultiRunTarget, attempt: number): void {
    const { status, failedStatementIndex } = finalStatus(t.statements);
    t.status = status;
    t.failedStatementIndex = failedStatementIndex;
    t.attempts.push({ attempt, status, failedStatementIndex });
  }

  private async executeAttempt(run: MultiRunState, indices: number[], historySql?: string): Promise<void> {
    const attempt = run.attempt;
    const total = indices.length;
    const started = Date.now();
    let done = 0;
    let wrote = false;
    const emit = (t: MultiRunTarget, results?: Record<number, QueryResult>) =>
      this.bridge.emit({ type: 'multiRunProgress', progress: { runId: run.runId, attempt, done, total, target: snapshotTarget(t), results } });
    try {
      const driver = this.driver(run.connectionId);
      await this.queries.run(`${run.runId}#${attempt}`, run.connectionId, async (signal) => {
        const queue = [...indices];
        const worker = async () => {
          for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
            const t = run.targets[i]!;
            if (signal.aborted) {
              this.settleTarget(t, attempt);
              done++;
              emit(t);
              continue;
            }
            t.status = 'running';
            emit(t);
            const r = await this.runTarget(run, t, driver, signal);
            wrote ||= r.wrote;
            done++;
            emit(t, r.results);
          }
        };
        await Promise.all(Array.from({ length: Math.min(run.concurrency, queue.length) }, worker));
        if (signal.aborted) run.cancelled = true;
      });
    } catch (err) {
      this.log('error', `Run on multiple databases stopped: ${this.connections.redact(err)}`, { connectionId: run.connectionId });
      for (const i of indices) {
        const t = run.targets[i]!;
        if (t.status === 'pending' || t.status === 'running') {
          this.settleTarget(t, attempt);
          emit(t);
        }
      }
    } finally {
      if (wrote) this.metadata.invalidate(run.connectionId);
      run.running = false;
      run.finishedAt = Date.now();
      const summary = summarize(run);
      this.bridge.emit({ type: 'multiRunFinished', summary });
      const c = summary.counts;
      this.log(
        c.failed || c.partial ? 'warn' : 'info',
        `Multi-database run${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${c.succeeded} succeeded, ${c.failed} failed, ${c.partial} partial, ${c.not_run} not run`,
        { connectionId: run.connectionId, durationMs: run.finishedAt - started },
      );
      if (historySql !== undefined) {
        await this.recordHistory({
          sql: historySql,
          connectionId: run.connectionId,
          databaseCount: run.targets.length,
          status: run.cancelled ? 'cancelled' : c.failed || c.partial ? 'error' : 'ok',
          durationMs: run.finishedAt - started,
          error: c.failed || c.partial ? `${c.failed} failed, ${c.partial} partial` : undefined,
        });
      }
    }
  }

  /** Runs the not-yet-applied statements of one database, stopping at its first failure. Never throws. */
  private async runTarget(
    run: MultiRunState,
    t: MultiRunTarget,
    driver: DbDriver,
    signal: AbortSignal,
  ): Promise<{ wrote: boolean; results: Record<number, QueryResult> }> {
    const from = resumeIndex(t);
    const results: Record<number, QueryResult> = {};
    let wrote = false;
    const started = Date.now();
    if (from >= 0) {
      for (let i = from; i < run.statements.length; i++) t.statements[i] = { status: 'not_run' };
      for (let i = from; i < run.statements.length; i++) {
        if (signal.aborted) break;
        const sql = run.statements[i]!;
        const readOnly = run.readOnly[i]!;
        if (!readOnly) wrote = true;
        try {
          const result = await driver.query(sql, [], this.queryOptions(signal, { database: t.database, readOnly }));
          t.statements[i] =
            result.kind === 'rows'
              ? { status: 'ok', attempt: run.attempt, durationMs: result.durationMs, rowCount: result.rows.length }
              : { status: 'ok', attempt: run.attempt, durationMs: result.durationMs, affectedRows: result.affectedRows ?? 0 };
          if (result.kind === 'rows') results[i] = result;
          const summary = result.kind === 'rows' ? `${result.rows.length} row(s)${result.truncated ? ' (truncated)' : ''}` : `${result.affectedRows ?? 0} row(s) affected — committed`;
          this.log(readOnly ? 'info' : 'warn', `${readOnly ? 'Query' : 'Write'} on ${t.database}: ${summary}`, {
            connectionId: run.connectionId,
            sql,
            durationMs: result.durationMs,
            rows: result.rows.length,
          });
        } catch (err) {
          const message = this.connections.redact(err);
          if (errorCode(err) === 'CANCELLED') {
            t.statements[i] = { status: 'not_run', attempt: run.attempt, error: message };
            break;
          }
          t.statements[i] = { status: 'error', attempt: run.attempt, error: message, errorCode: detailedErrorCode(err) };
          this.log('error', `${t.database}: ${message}`, { connectionId: run.connectionId, sql });
          break;
        }
      }
    }
    t.durationMs = Date.now() - started;
    this.settleTarget(t, run.attempt);
    return { wrote, results };
  }

  private async runDataSearch(r: DataSearchRequest, controller: AbortController): Promise<void> {
    const total = r.tables.length;
    const emit = (p: Omit<DataSearchProgress, 'searchId' | 'total'>) =>
      this.bridge.emit({ type: 'searchProgress', progress: { searchId: r.searchId, total, ...p } });
    const driver = this.driver(r.connectionId);
    this.log('info', `Data search for "${r.term}" in ${total} table(s) of ${r.database}`, { connectionId: r.connectionId });
    for (const [i, table] of r.tables.entries()) {
      if (controller.signal.aborted) {
        emit({ done: i, finished: true, cancelled: true });
        return;
      }
      emit({ done: i, current: table, finished: false });
      const base = { connectionId: r.connectionId, database: r.database, table };
      try {
        const details = await this.metadata.tableDetails(r.connectionId, r.database, table);
        const built = buildDataSearchQuery(details, r.term, r.match, r.perTableLimit, r.columns?.[table]);
        if (!built) {
          emit({ done: i + 1, finished: false, result: { ...base, searchedColumns: [], columns: [], rows: [], limited: false } });
          continue;
        }
        const result = await driver.query(built.sql, built.params, this.queryOptions(controller.signal, { maxRows: r.perTableLimit, readOnly: true }));
        emit({
          done: i + 1,
          finished: false,
          result: { ...base, searchedColumns: built.searchedColumns, columns: result.columns, rows: result.rows, limited: result.rows.length >= r.perTableLimit },
        });
      } catch (err) {
        if (errorCode(err) === 'CANCELLED') {
          emit({ done: i, finished: true, cancelled: true });
          return;
        }
        emit({ done: i + 1, finished: false, result: { ...base, searchedColumns: [], columns: [], rows: [], limited: false, error: this.connections.redact(err) } });
      }
    }
    emit({ done: total, finished: true });
  }
}
