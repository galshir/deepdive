import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryEntry, SavedQuery } from '../../../shared/model';
import { ErrorBox, Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { errorMessage, rpc } from '../../lib/rpc';
import { shortSql } from '../../lib/util';
import { useStore } from '../../store';

export interface LoadTarget {
  sql: string;
  connectionId?: string;
  database?: string;
  savedQueryId?: string;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function useConnectionName() {
  const connections = useStore((s) => s.connections);
  return (id?: string) => (id ? (connections.find((c) => c.config.id === id)?.config.name ?? 'removed connection') : undefined);
}

export interface SaveRequest {
  sql: string;
  connectionId?: string;
  database?: string;
  /** The saved query being updated; omitted to create a new one. */
  existing?: SavedQuery;
  /** Whether the editor text is what is being saved (then the editor remembers the saved query). */
  fromEditor: boolean;
}

export function SaveQueryDialog({ request, onClose }: { request: SaveRequest; onClose: () => void }) {
  const { sql, connectionId, database, existing, fromEditor } = request;
  const connName = useConnectionName()(connectionId);
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [tags, setTags] = useState(existing?.tags.join(', ') ?? '');
  const [remember, setRemember] = useState(existing ? Boolean(existing.connectionId) : Boolean(connectionId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const save = async (asNew: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await rpc({
        type: 'saveQuery',
        query: {
          id: asNew ? undefined : existing?.id,
          name,
          description: description || undefined,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          sql,
          connectionId: remember ? connectionId : undefined,
          database: remember ? database : undefined,
        },
      });
      if (fromEditor) useStore.getState().updateSql({ savedQueryId: saved.id });
      useStore.getState().toast('success', `Saved "${saved.name}"`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="save-query-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="save-query-title">{existing ? `Update "${existing.name}"` : 'Save query'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <div className="form-grid">
            <label className="span2">
              Name
              <input ref={first} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Active users per tenant" />
            </label>
            <label className="span2">
              Description
              <input maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
            </label>
            <label className="span2">
              Tags
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Comma separated, e.g. reports, migrations" />
            </label>
            <label className="check span2">
              <input type="checkbox" checked={remember} disabled={!connectionId} onChange={(e) => setRemember(e.target.checked)} />
              {connectionId ? `Remember connection and database (${connName}${database ? ` / ${database}` : ''})` : 'Remember connection and database (none selected)'}
            </label>
            <pre className="span2 save-sql-preview">{shortSql(sql, 600)}</pre>
          </div>
          {error ? <ErrorBox message={error} /> : null}
          <div className="modal-actions">
            <span className="spacer" />
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            {existing ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void save(true)}>
                Save as new
              </button>
            ) : null}
            <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
              {existing ? 'Update' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SavedItem({ q, onLoad, onRun, onEdit }: { q: SavedQuery; onLoad: (t: LoadTarget, insert: boolean) => void; onRun: (t: LoadTarget) => void; onEdit: (q: SavedQuery) => void }) {
  const connName = useConnectionName()(q.connectionId);
  const target = { sql: q.sql, connectionId: q.connectionId, database: q.database, savedQueryId: q.id };
  return (
    <div className="lib-item">
      <button type="button" className="lib-main" onClick={(e) => onLoad(target, e.altKey)} title="Load into the editor (Alt+click inserts at the cursor)">
        <span className="lib-title">
          <strong>{q.name}</strong>
          {q.tags.map((t) => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
        </span>
        {q.description ? <span className="muted small">{q.description}</span> : null}
        <code className="lib-sql">{shortSql(q.sql, 160)}</code>
        <span className="lib-meta muted small">
          {connName ? `${connName}${q.database ? ` / ${q.database}` : ''} · ` : ''}
          {q.runCount ? `ran ${q.runCount}× · last ${ago(q.lastRunAt ?? q.updatedAt)}` : `saved ${ago(q.updatedAt)}`}
        </span>
      </button>
      <div className="lib-actions">
        <button type="button" className="icon-btn" aria-label={`Run ${q.name}`} title="Load and run" onClick={() => onRun(target)}>
          <Icon name="play" />
        </button>
        <button type="button" className="icon-btn" aria-label={`Edit ${q.name}`} title="Rename / edit details" onClick={() => onEdit(q)}>
          <Icon name="edit" />
        </button>
        <button type="button" className="icon-btn" aria-label={`Copy ${q.name}`} title="Copy SQL" onClick={() => void rpc({ type: 'copyText', text: q.sql })}>
          <Icon name="copy" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Delete ${q.name}`}
          title="Delete"
          onClick={() => void rpc({ type: 'deleteSavedQuery', id: q.id }).catch((err: unknown) => useStore.getState().toast('error', errorMessage(err)))}
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
}

function HistoryItem({ h, onLoad, onSave }: { h: HistoryEntry; onLoad: (t: LoadTarget, insert: boolean) => void; onSave: (h: HistoryEntry) => void }) {
  const connName = useConnectionName()(h.connectionId);
  const where = h.databaseCount ? `${connName} / ${h.databaseCount} databases` : `${connName ?? ''}${h.database ? ` / ${h.database}` : ''}`;
  return (
    <div className={`lib-item hist-${h.status}`}>
      <button type="button" className="lib-main" onClick={(e) => onLoad({ sql: h.sql, connectionId: h.connectionId, database: h.database }, e.altKey)} title={h.error ?? 'Load into the editor (Alt+click inserts at the cursor)'}>
        <code className="lib-sql">
          <Icon name={h.status === 'ok' ? 'check' : h.status === 'error' ? 'warn' : 'stop'} size={12} className={`hist-icon ${h.status}`} /> {shortSql(h.sql, 160)}
        </code>
        <span className="lib-meta muted small">
          {ago(h.executedAt)}
          {where ? ` · ${where}` : ''} · {h.durationMs} ms{h.rowCount !== undefined ? ` · ${h.rowCount} row(s)` : ''}
          {h.runs > 1 ? ` · ${h.runs}×` : ''}
          {h.status === 'error' && h.error ? ` · ${h.error.slice(0, 80)}` : ''}
        </span>
      </button>
      <div className="lib-actions">
        <button type="button" className="icon-btn" aria-label="Save this query" title="Save…" onClick={() => onSave(h)}>
          <Icon name="save" />
        </button>
        <button type="button" className="icon-btn" aria-label="Copy SQL" title="Copy SQL" onClick={() => void rpc({ type: 'copyText', text: h.sql })}>
          <Icon name="copy" />
        </button>
        <button type="button" className="icon-btn" aria-label="Remove from history" title="Remove from history" onClick={() => void rpc({ type: 'deleteHistoryEntry', id: h.id })}>
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}

/** The SQL editor's "Queries" popover: saved queries and the persistent run history. */
export function QueriesPopover({
  connectionId,
  onLoad,
  onRun,
  onEditSaved,
  onSaveFromHistory,
  onClose,
}: {
  connectionId?: string;
  onLoad: (t: LoadTarget, insert: boolean) => void;
  onRun: (t: LoadTarget) => void;
  onEditSaved: (q: SavedQuery) => void;
  onSaveFromHistory: (h: HistoryEntry) => void;
  onClose: () => void;
}) {
  const saved = useStore((s) => s.savedQueries);
  const historyVersion = useStore((s) => s.historyVersion);
  const historyEnabled = useStore((s) => s.settings.historyEnabled);
  const [tab, setTab] = useState<'saved' | 'history'>(saved.length ? 'saved' : 'history');
  const [term, setTerm] = useState('');
  const [onlyThis, setOnlyThis] = useState(false);
  const [history, setHistory] = useState<{ loading: boolean; entries: HistoryEntry[]; error?: string }>({ loading: true, entries: [] });

  useEffect(() => {
    let live = true;
    rpc({ type: 'listHistory', limit: 500 })
      .then((entries) => live && setHistory({ loading: false, entries }))
      .catch((err: unknown) => live && setHistory({ loading: false, entries: [], error: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [historyVersion]);

  const t = term.trim().toLowerCase();
  const scope = onlyThis && connectionId ? connectionId : undefined;
  const savedShown = useMemo(
    () =>
      saved.filter(
        (q) =>
          (!scope || q.connectionId === scope) &&
          (!t || q.name.toLowerCase().includes(t) || q.sql.toLowerCase().includes(t) || q.tags.some((tag) => tag.toLowerCase().includes(t)) || q.description?.toLowerCase().includes(t)),
      ),
    [saved, scope, t],
  );
  const historyShown = useMemo(() => history.entries.filter((h) => (!scope || h.connectionId === scope) && (!t || h.sql.toLowerCase().includes(t))), [history.entries, scope, t]);

  return (
    <div className="popover queries-popover" role="dialog" aria-label="Saved queries and history" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="popover-head">
        <div className="segmented" role="tablist" aria-label="Query list">
          <button type="button" role="tab" aria-selected={tab === 'saved'} className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>
            Saved <span className="pill">{saved.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
            History
          </button>
        </div>
        <input className="grow" type="search" autoFocus placeholder={tab === 'saved' ? 'Search name, SQL or tag…' : 'Search SQL…'} value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Filter queries" />
        <label className="check small" title="Only queries for the current connection">
          <input type="checkbox" checked={onlyThis} disabled={!connectionId} onChange={(e) => setOnlyThis(e.target.checked)} />
          this connection
        </label>
      </div>
      <div className="popover-list">
        {tab === 'saved' ? (
          savedShown.length ? (
            savedShown.map((q) => <SavedItem key={q.id} q={q} onLoad={onLoad} onRun={onRun} onEdit={onEditSaved} />)
          ) : (
            <div className="muted small pad">{saved.length ? 'No saved query matches.' : 'No saved queries yet. Use Save (Ctrl/Cmd+Shift+S) in the SQL editor, or save one from the history.'}</div>
          )
        ) : history.loading ? (
          <Spinner label="Loading history…" />
        ) : history.error ? (
          <ErrorBox message={history.error} />
        ) : historyShown.length ? (
          historyShown.map((h) => <HistoryItem key={h.id} h={h} onLoad={onLoad} onSave={onSaveFromHistory} />)
        ) : (
          <div className="muted small pad">{historyEnabled ? (history.entries.length ? 'No history entry matches.' : 'Queries you run appear here.') : 'History is turned off (setting deepdive.history.enabled).'}</div>
        )}
      </div>
      {tab === 'history' && history.entries.length ? (
        <div className="popover-foot">
          <span className="muted small">{history.entries.length} entr{history.entries.length === 1 ? 'y' : 'ies'}</span>
          <span className="spacer" />
          <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'clearHistory' })}>
            <Icon name="trash" /> Clear history
          </button>
        </div>
      ) : null}
    </div>
  );
}
