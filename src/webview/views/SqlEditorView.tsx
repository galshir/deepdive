import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ConnectionDatabasePicker, ErrorBox, Kbd, Spinner } from '../components/common';
import { DataGrid } from '../components/DataGrid';
import { Icon } from '../components/Icon';
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor';
import { errorMessage, rpc, RpcError } from '../lib/rpc';
import { key, shortSql, toTsv, uid } from '../lib/util';
import { type SqlState, useStore } from '../store';
import { MultiRunReport, type ReportActions } from './sql/MultiRunReport';
import { type LoadTarget, QueriesPopover, SaveQueryDialog, type SaveRequest } from './sql/QueryLibrary';
import { TargetPicker } from './sql/TargetPicker';

export function SqlEditorView() {
  const sql = useStore((s) => s.sql);
  const active = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const savedQueries = useStore((s) => s.savedQueries);
  const conn = connections.find((c) => c.config.id === (sql.connectionId ?? active));
  const connectionId = conn?.status === 'connected' ? conn.config.id : undefined;
  const tables = useStore((s) => (connectionId && sql.database ? s.tables[key(connectionId, sql.database)] : undefined));
  const schemaLoad = useStore((s) => (connectionId && sql.database ? s.schemas[key(connectionId, sql.database)] : undefined));
  const editor = useRef<SqlEditorHandle>(null);
  const [showQueries, setShowQueries] = useState(false);
  const [saveRequest, setSaveRequest] = useState<SaveRequest>();
  const [showTargets, setShowTargets] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const multi = sql.mode === 'multi';
  const targets = connectionId && sql.targets.connectionId === connectionId ? sql.targets.databases : [];
  const multiRunning = Boolean(sql.multiRun?.summary.running) || sql.multiStarting;
  const linked = savedQueries.find((q) => q.id === sql.savedQueryId);
  const runConn = connections.find((c) => c.config.id === sql.multiRun?.summary.connectionId);

  // Autocomplete metadata: full column lists for normal-sized databases, table names only for huge ones.
  useEffect(() => {
    if (!connectionId || !sql.database) return;
    void useStore
      .getState()
      .loadTables(connectionId, sql.database)
      .then((t) => {
        if (t && t.length <= 500 && sql.database) void useStore.getState().loadSchema(connectionId, sql.database);
      });
  }, [connectionId, sql.database]);

  const completion = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (schemaLoad?.data) {
      for (const c of schemaLoad.data.columns) (out[c.table] ??= []).push(c.name);
    } else {
      for (const t of tables?.data ?? []) out[t.name] = [];
    }
    return out;
  }, [schemaLoad?.data, tables?.data]);

  const runSingle = async (override?: { text: string; connectionId: string; database?: string; savedQueryId?: string }) => {
    const target = override?.connectionId ?? connectionId;
    if (!target || sql.running) return;
    const text = override?.text ?? editor.current?.getRunnableText() ?? sql.text;
    if (!text.trim()) return;
    const database = override ? override.database : sql.database;
    const savedId = override ? override.savedQueryId : sql.savedQueryId;
    const queryId = uid('sql');
    useStore.getState().updateSql({ running: true, queryId, results: [], cancelled: false, activeResult: 0, connectionId: target });
    try {
      const savedQueryId = savedQueries.some((q) => q.id === savedId && q.sql === text) ? savedId : undefined;
      const res = await rpc({ type: 'runSql', connectionId: target, queryId, sql: text, database, savedQueryId });
      const lastRows = res.statements.map((st, i) => (st.result?.kind === 'rows' ? i : -1)).filter((i) => i >= 0).pop();
      const firstError = res.statements.findIndex((st) => st.error);
      useStore.getState().updateSql({ running: false, results: res.statements, cancelled: res.cancelled, activeResult: firstError >= 0 ? firstError : (lastRows ?? 0) });
    } catch (err) {
      useStore.getState().updateSql({ running: false, results: [{ sql: text, error: errorMessage(err) }], activeResult: 0 });
    }
  };

  const multiFailed = (err: unknown) => {
    if (err instanceof RpcError && err.code === 'DECLINED') useStore.getState().toast('info', err.message);
    else useStore.getState().updateSql({ multiError: errorMessage(err) });
  };

  const startMulti = async (databases: string[], text: string) => {
    if (!connectionId || multiRunning || databases.length === 0 || !text.trim()) return;
    const runId = uid('mr');
    useStore.getState().updateSql({ multiStarting: true, multiError: undefined });
    const previous = useStore.getState().beginMultiRun(runId, connectionId, databases);
    try {
      const snapshot = await rpc({ type: 'runSqlMulti', connectionId, runId, sql: text, databases, concurrency: sql.concurrency });
      useStore.getState().applyMultiRunSnapshot(snapshot);
    } catch (err) {
      useStore.getState().updateSql({ multiRun: previous });
      multiFailed(err);
    } finally {
      useStore.getState().updateSql({ multiStarting: false });
    }
  };

  const run = () => {
    if (multi) {
      if (targets.length === 0) setShowTargets(true);
      else void startMulti(targets, editor.current?.getRunnableText() ?? sql.text);
    } else {
      void runSingle();
    }
  };

  const reportActions: ReportActions = {
    retry: (mode, database) => {
      const runId = sql.multiRun?.summary.runId;
      if (!runId) return;
      setRetrying(true);
      useStore.getState().updateSql({ multiError: undefined });
      rpc({ type: 'retryMultiRun', runId, mode, database })
        .then((snapshot) => useStore.getState().applyMultiRunSnapshot(snapshot))
        .catch(multiFailed)
        .finally(() => setRetrying(false));
    },
    runEdited: (databases) => void startMulti(databases, sql.text),
    openInEditor: (database) => {
      useStore.getState().updateSql({ mode: 'single', connectionId: sql.multiRun?.summary.connectionId, database });
      editor.current?.focus();
    },
  };

  /** Loads a saved or history query into the editor, switching connection/database when possible. */
  const loadQuery = (t: LoadTarget, insert: boolean): { connectionId?: string; database?: string } => {
    setShowQueries(false);
    if (insert) {
      editor.current?.insertText(t.sql);
      return { connectionId, database: sql.database };
    }
    const patch: Partial<SqlState> = { text: t.sql, savedQueryId: t.savedQueryId };
    if (t.connectionId && t.connectionId !== connectionId) {
      const c = connections.find((x) => x.config.id === t.connectionId);
      if (c?.status === 'connected') {
        patch.connectionId = t.connectionId;
        patch.database = t.database;
      } else {
        useStore.getState().toast('info', c ? `"${c.config.name}" is not connected — the query was loaded for the current connection.` : 'The saved connection no longer exists — the query was loaded for the current connection.');
      }
    } else if (t.connectionId && t.database) {
      patch.database = t.database;
    }
    useStore.getState().updateSql(patch);
    return { connectionId: patch.connectionId ?? connectionId, database: 'database' in patch ? patch.database : sql.database };
  };

  const runQuery = (t: LoadTarget) => {
    const where = loadQuery(t, false);
    if (multi) void startMulti(targets, t.sql);
    else if (where.connectionId) void runSingle({ text: t.sql, connectionId: where.connectionId, database: where.database, savedQueryId: t.savedQueryId });
  };

  const openSave = () => {
    if (!sql.text.trim()) return;
    setSaveRequest({ sql: sql.text, connectionId, database: sql.database, existing: linked, fromEditor: true });
  };

  const current = sql.results[sql.activeResult];
  const r = current?.result;

  return (
    <div className="view sql-view">
      <div className="view-toolbar">
        <ConnectionDatabasePicker connectionId={connectionId} database={sql.database} allowNoDatabase onChange={(c, d) => useStore.getState().updateSql({ connectionId: c, database: d })} />
        <div className="segmented" role="radiogroup" aria-label="Run on">
          <button type="button" role="radio" aria-checked={!multi} className={!multi ? 'on' : ''} disabled={multiRunning || sql.running} onClick={() => useStore.getState().updateSql({ mode: 'single' })}>
            One database
          </button>
          <button type="button" role="radio" aria-checked={multi} className={multi ? 'on' : ''} disabled={multiRunning || sql.running} onClick={() => useStore.getState().updateSql({ mode: 'multi' })}>
            Multiple databases
          </button>
        </div>
        {multi ? (
          <button type="button" className="btn small" disabled={!connectionId || multiRunning} onClick={() => setShowTargets(true)} title={targets.length ? targets.join(', ') : undefined}>
            <Icon name="database" /> {targets.length ? `${targets.length} database${targets.length === 1 ? '' : 's'}` : 'Choose databases…'}
            {sql.concurrency > 1 ? <span className="muted"> · ×{sql.concurrency}</span> : null}
          </button>
        ) : null}
        {conn?.config.readOnly ? (
          <span className="badge" title="Write statements are refused on this connection">
            <Icon name="lock" size={11} /> read-only
          </span>
        ) : conn ? (
          <span className="badge warn" title="Write statements ask for confirmation and are committed by MySQL (autocommit)">
            writes need confirmation
          </span>
        ) : null}
        <span className="spacer" />
        {linked ? (
          <span className="badge" title={`Loaded from the saved query "${linked.name}"${linked.sql !== sql.text ? ' (modified)' : ''}`}>
            <Icon name="save" size={11} /> {linked.name}
            {linked.sql !== sql.text ? ' *' : ''}
          </span>
        ) : null}
        <button type="button" className="btn small ghost" onClick={openSave} disabled={!sql.text.trim()} title="Save this query (Ctrl/Cmd+Shift+S)">
          <Icon name="save" /> Save
        </button>
        <button type="button" className="btn small ghost" aria-expanded={showQueries} onClick={() => setShowQueries((v) => !v)}>
          <Icon name="history" /> Queries
        </button>
        <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'openSqlDocument', sql: sql.text })} disabled={!sql.text.trim()}>
          <Icon name="external" /> Open in VS Code
        </button>
        {sql.running || (multi && multiRunning) ? (
          <button
            type="button"
            className="btn small"
            disabled={multi && !sql.multiRun?.summary.running}
            onClick={() => {
              if (multi && sql.multiRun) void rpc({ type: 'cancelMultiRun', runId: sql.multiRun.summary.runId });
              else if (sql.queryId) void rpc({ type: 'cancelQuery', queryId: sql.queryId });
            }}
          >
            <Icon name="stop" /> Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn small primary"
            onClick={run}
            disabled={!connectionId || !sql.text.trim()}
            title={multi ? `Run selection or whole script on each chosen database (Ctrl/Cmd+Enter)` : 'Run selection or whole script (Ctrl/Cmd+Enter)'}
          >
            <Icon name="play" /> {multi ? `Run on ${targets.length || '…'}` : 'Run'} <Kbd>⌘↵</Kbd>
          </button>
        )}
        {showQueries ? (
          <QueriesPopover
            connectionId={connectionId}
            onLoad={(t, insert) => void loadQuery(t, insert)}
            onRun={runQuery}
            onEditSaved={(q) => {
              setShowQueries(false);
              setSaveRequest({ sql: q.sql, connectionId: q.connectionId, database: q.database, existing: q, fromEditor: false });
            }}
            onSaveFromHistory={(h) => {
              setShowQueries(false);
              setSaveRequest({ sql: h.sql, connectionId: h.connectionId, database: h.database, fromEditor: false });
            }}
            onClose={() => setShowQueries(false)}
          />
        ) : null}
      </div>
      <PanelGroup direction="vertical" autoSaveId="deepdive-sql">
        <Panel defaultSize={45} minSize={15}>
          <SqlEditor
            ref={editor}
            value={sql.text}
            onChange={(text) => useStore.getState().updateSql({ text })}
            onRun={run}
            onSave={openSave}
            schema={completion}
            placeholder={connectionId ? 'Write SQL… Ctrl/Cmd+Enter runs the selection or the whole script.' : 'Connect to a server to run SQL.'}
          />
        </Panel>
        <PanelResizeHandle className="resize-handle horizontal" />
        <Panel defaultSize={55} minSize={15}>
          {multi ? (
            <div className="sql-results">
              {sql.multiError ? <ErrorBox message={sql.multiError} /> : null}
              {sql.multiStarting && !sql.multiRun ? <Spinner label="Starting…" /> : null}
              {sql.multiRun ? (
                <MultiRunReport
                  key={sql.multiRun.summary.runId}
                  view={sql.multiRun}
                  connectionName={runConn?.config.name ?? 'removed connection'}
                  production={runConn?.config.environment === 'production'}
                  editorText={sql.text}
                  actions={reportActions}
                  busy={retrying || multiRunning}
                />
              ) : !sql.multiStarting && !sql.multiError ? (
                <div className="muted small pad">
                  Choose databases, then Run. The script runs on each database separately (as its default database). A database that fails is skipped and the run continues; at the end a report shows what
                  succeeded, what failed and why, and lets you retry.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="sql-results">
              {sql.running ? <Spinner label="Running…" /> : null}
              {sql.cancelled ? <div className="notice small">Execution was cancelled. Statements after the cancelled one were not run.</div> : null}
              {sql.results.length > 1 ? (
                <div className="tabs small" role="tablist" aria-label="Statement results">
                  {sql.results.map((st, i) => (
                    <button key={i} type="button" role="tab" aria-selected={i === sql.activeResult} className={`tab ${i === sql.activeResult ? 'active' : ''} ${st.error ? 'err' : ''}`} onClick={() => useStore.getState().updateSql({ activeResult: i })} title={st.sql}>
                      {i + 1}. {shortSql(st.sql, 28)}
                    </button>
                  ))}
                </div>
              ) : null}
              {current?.error ? <ErrorBox message={current.error} /> : null}
              {r?.kind === 'ok' ? (
                <div className="ok-box">
                  <Icon name="check" /> Statement executed — {r.affectedRows ?? 0} row(s) affected{r.insertId ? `, insert id ${r.insertId}` : ''}. Confirmed by the server ({r.durationMs} ms).
                </div>
              ) : null}
              {r?.kind === 'rows' ? (
                <>
                  <div className="result-meta muted small">
                    {r.rows.length.toLocaleString()} row(s){r.truncated ? ` — truncated at the ${r.rows.length.toLocaleString()}-row limit (setting deepdive.maxResultRows)` : ''} · {r.durationMs} ms
                    <button type="button" className="link" onClick={() => void rpc({ type: 'copyText', text: toTsv(r.columns.map((c) => c.name), r.rows) })}>
                      copy as TSV
                    </button>
                  </div>
                  <DataGrid columns={r.columns.map((c) => ({ name: c.name, type: c.type }))} rows={r.rows} ariaLabel="SQL results" emptyMessage="Query returned no rows." />
                </>
              ) : null}
              {!sql.running && sql.results.length === 0 ? (
                <div className="muted small pad">
                  Results appear here. Read-only statements run inside a read-only transaction where supported; anything that writes asks for confirmation first.
                </div>
              ) : null}
            </div>
          )}
        </Panel>
      </PanelGroup>
      {saveRequest ? <SaveQueryDialog key={saveRequest.existing?.id ?? 'new'} request={saveRequest} onClose={() => setSaveRequest(undefined)} /> : null}
      {showTargets && connectionId ? <TargetPicker connectionId={connectionId} onClose={() => setShowTargets(false)} /> : null}
    </div>
  );
}
