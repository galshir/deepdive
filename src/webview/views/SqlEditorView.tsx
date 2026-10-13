import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ConnectionDatabasePicker, ErrorBox, Kbd, Spinner } from '../components/common';
import { DataGrid } from '../components/DataGrid';
import { Icon } from '../components/Icon';
import { SqlEditor, type SqlEditorHandle } from '../components/SqlEditor';
import { errorMessage, rpc } from '../lib/rpc';
import { key, shortSql, toTsv, uid } from '../lib/util';
import { useStore } from '../store';

export function SqlEditorView() {
  const sql = useStore((s) => s.sql);
  const active = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const conn = connections.find((c) => c.config.id === (sql.connectionId ?? active));
  const connectionId = conn?.status === 'connected' ? conn.config.id : undefined;
  const tables = useStore((s) => (connectionId && sql.database ? s.tables[key(connectionId, sql.database)] : undefined));
  const schemaLoad = useStore((s) => (connectionId && sql.database ? s.schemas[key(connectionId, sql.database)] : undefined));
  const editor = useRef<SqlEditorHandle>(null);
  const [showHistory, setShowHistory] = useState(false);

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

  const run = async () => {
    if (!connectionId || sql.running) return;
    const text = editor.current?.getRunnableText() ?? sql.text;
    if (!text.trim()) return;
    const queryId = uid('sql');
    useStore.getState().updateSql((s) => ({
      running: true,
      queryId,
      results: [],
      cancelled: false,
      activeResult: 0,
      history: [text, ...s.history.filter((h) => h !== text)].slice(0, 50),
      connectionId,
    }));
    try {
      const res = await rpc({ type: 'runSql', connectionId, queryId, sql: text, database: sql.database });
      const lastRows = res.statements.map((st, i) => (st.result?.kind === 'rows' ? i : -1)).filter((i) => i >= 0).pop();
      const firstError = res.statements.findIndex((st) => st.error);
      useStore.getState().updateSql({ running: false, results: res.statements, cancelled: res.cancelled, activeResult: firstError >= 0 ? firstError : (lastRows ?? 0) });
    } catch (err) {
      useStore.getState().updateSql({ running: false, results: [{ sql: text, error: errorMessage(err) }], activeResult: 0 });
    }
  };

  const current = sql.results[sql.activeResult];
  const r = current?.result;

  return (
    <div className="view sql-view">
      <div className="view-toolbar">
        <ConnectionDatabasePicker connectionId={connectionId} database={sql.database} allowNoDatabase onChange={(c, d) => useStore.getState().updateSql({ connectionId: c, database: d })} />
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
        <div className="popover-anchor">
          <button type="button" className="btn small ghost" onClick={() => setShowHistory((v) => !v)} disabled={sql.history.length === 0}>
            <Icon name="history" /> History
          </button>
          {showHistory ? (
            <div className="popover right" role="dialog" aria-label="Query history">
              <div className="popover-list">
                {sql.history.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="history-item"
                    onClick={() => {
                      useStore.getState().updateSql({ text: h });
                      setShowHistory(false);
                    }}
                  >
                    {shortSql(h, 140)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'openSqlDocument', sql: sql.text })} disabled={!sql.text.trim()}>
          <Icon name="external" /> Open in VS Code
        </button>
        {sql.running ? (
          <button type="button" className="btn small" onClick={() => sql.queryId && void rpc({ type: 'cancelQuery', queryId: sql.queryId })}>
            <Icon name="stop" /> Cancel
          </button>
        ) : (
          <button type="button" className="btn small primary" onClick={() => void run()} disabled={!connectionId || !sql.text.trim()} title="Run selection or whole script (Ctrl/Cmd+Enter)">
            <Icon name="play" /> Run <Kbd>⌘↵</Kbd>
          </button>
        )}
      </div>
      <PanelGroup direction="vertical" autoSaveId="deepdive-sql">
        <Panel defaultSize={45} minSize={15}>
          <SqlEditor
            ref={editor}
            value={sql.text}
            onChange={(text) => useStore.getState().updateSql({ text })}
            onRun={() => void run()}
            schema={completion}
            placeholder={connectionId ? 'Write SQL… Ctrl/Cmd+Enter runs the selection or the whole script.' : 'Connect to a server to run SQL.'}
          />
        </Panel>
        <PanelResizeHandle className="resize-handle horizontal" />
        <Panel defaultSize={55} minSize={15}>
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
        </Panel>
      </PanelGroup>
    </div>
  );
}
