import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MetadataHit } from '../../shared/model';
import { ConnDot, EmptyState, ErrorBox, Spinner } from '../components/common';
import { DataGrid } from '../components/DataGrid';
import { Icon } from '../components/Icon';
import { emptyGroup, newCondition } from '../lib/filters';
import { errorMessage, rpc } from '../lib/rpc';
import { key, uid } from '../lib/util';
import { useStore } from '../store';

const METADATA_LIMIT = 200;
let handledToken = 0;

export function SearchView() {
  const search = useStore((s) => s.search);
  const connections = useStore((s) => s.connections);
  const connected = connections.filter((c) => c.status === 'connected');
  const update = useStore((s) => s.updateSearch);

  const runMetadata = useCallback(async () => {
    const s = useStore.getState().search;
    const term = s.term.trim();
    if (!term) return;
    const ids = s.connectionIds.length ? s.connectionIds : undefined;
    update({ metadata: { hits: [], limited: false, errors: [], loading: true } });
    try {
      const r = await rpc({ type: 'searchMetadata', term, connectionIds: ids, limit: METADATA_LIMIT });
      update({ metadata: { ...r, loading: false } });
    } catch (err) {
      update({ metadata: { hits: [], limited: false, errors: [], loading: false, error: errorMessage(err) } });
    }
  }, [update]);

  // The toolbar/canvas search bumps runToken; run once per token, also when the request arrived before mount.
  useEffect(() => {
    if (search.runToken > handledToken) {
      handledToken = search.runToken;
      void runMetadata();
    }
  }, [search.runToken, runMetadata]);

  return (
    <div className="view search-view">
      <form
        className="view-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (search.mode === 'metadata') void runMetadata();
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="Search mode">
          <button type="button" role="radio" aria-checked={search.mode === 'metadata'} className={search.mode === 'metadata' ? 'on' : ''} onClick={() => update({ mode: 'metadata' })}>
            Names (metadata)
          </button>
          <button type="button" role="radio" aria-checked={search.mode === 'data'} className={search.mode === 'data' ? 'on' : ''} onClick={() => update({ mode: 'data' })}>
            Data in tables
          </button>
        </div>
        <div className="search-input">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Search term"
            placeholder={search.mode === 'metadata' ? 'Database, table or column name…' : 'Value to find…'}
            value={search.term}
            onChange={(e) => update({ term: e.target.value })}
          />
        </div>
        {search.mode === 'metadata' ? (
          <button type="submit" className="btn small primary" disabled={!search.term.trim() || connected.length === 0}>
            Search
          </button>
        ) : null}
      </form>
      {connected.length === 0 ? (
        <EmptyState icon="search" title="No connected servers">
          Connect to at least one server to search.
        </EmptyState>
      ) : search.mode === 'metadata' ? (
        <MetadataSearch runMetadata={runMetadata} />
      ) : (
        <DataSearch />
      )}
    </div>
  );
}

function MetadataSearch({ runMetadata }: { runMetadata: () => Promise<void> }) {
  const search = useStore((s) => s.search);
  const connections = useStore((s) => s.connections);
  const connected = connections.filter((c) => c.status === 'connected');
  const [kind, setKind] = useState<'all' | MetadataHit['kind']>('all');
  const [dbFilter, setDbFilter] = useState('');
  const m = search.metadata;
  const hits = useMemo(() => (m?.hits ?? []).filter((h) => (kind === 'all' || h.kind === kind) && (!dbFilter || h.database === dbFilter)), [m?.hits, kind, dbFilter]);
  const dbs = useMemo(() => [...new Set((m?.hits ?? []).map((h) => h.database))].sort(), [m?.hits]);
  const st = useStore.getState();

  const open = (h: MetadataHit) => {
    if (h.kind === 'database') {
      st.select({ kind: 'database', connectionId: h.connectionId, database: h.database });
      st.toggleExpanded(`db:${key(h.connectionId, h.database)}`, true);
      void st.loadTables(h.connectionId, h.database);
    } else if (h.kind === 'table') {
      st.select({ kind: 'table', connectionId: h.connectionId, database: h.database, table: h.table! });
    } else {
      st.select({ kind: 'column', connectionId: h.connectionId, database: h.database, table: h.table!, column: h.column! });
    }
  };

  return (
    <div className="search-body">
      <div className="scope-bar">
        <span className="muted small">Connections:</span>
        {connected.map((c) => {
          const on = search.connectionIds.length === 0 || search.connectionIds.includes(c.config.id);
          return (
            <label key={c.config.id} className="chip check">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => {
                  const current = search.connectionIds.length ? search.connectionIds : connected.map((x) => x.config.id);
                  const next = e.target.checked ? [...current, c.config.id] : current.filter((id) => id !== c.config.id);
                  st.updateSearch({ connectionIds: next.length === connected.length ? [] : next });
                }}
              />
              <ConnDot color={c.config.color} /> {c.config.name}
            </label>
          );
        })}
        <span className="spacer" />
        <select aria-label="Result type" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">All types</option>
          <option value="database">Databases</option>
          <option value="table">Tables</option>
          <option value="column">Columns</option>
        </select>
        <select aria-label="Database filter" value={dbFilter} onChange={(e) => setDbFilter(e.target.value)}>
          <option value="">All databases</option>
          {dbs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      {m?.loading ? <Spinner label="Searching metadata…" /> : null}
      {m?.error ? <ErrorBox message={m.error} onRetry={() => void runMetadata()} /> : null}
      {m?.errors.map((e) => <ErrorBox key={e} message={e} />)}
      {m && !m.loading && !m.error ? (
        <div className="muted small pad-s">
          {hits.length} result(s){m.limited ? ` — limited to ${METADATA_LIMIT} per type, refine the term to see more` : ''}
        </div>
      ) : null}
      {!m ? <div className="muted small pad">Searches database, table and column names across the selected connections (partial, case-insensitive).</div> : null}
      <ul className="hit-list">
        {hits.map((h, i) => {
          const c = connections.find((x) => x.config.id === h.connectionId);
          return (
            <li key={`${h.connectionId}.${h.database}.${h.table}.${h.column}.${i}`}>
              <button type="button" className="hit" onClick={() => open(h)} onDoubleClick={() => h.kind !== 'database' && st.openTable(h.connectionId, h.database, h.table!)}>
                <Icon name={h.kind === 'database' ? 'database' : h.kind === 'table' ? (h.detail === 'view' ? 'view' : 'table') : 'column'} />
                <span className="hit-path">
                  {c ? <ConnDot color={c.config.color} /> : null}
                  <span className="muted">{c?.config.name} ›</span> {h.database}
                  {h.table ? <span className="muted"> › </span> : null}
                  {h.table}
                  {h.column ? (
                    <>
                      <span className="muted"> › </span>
                      <b>{h.column}</b>
                    </>
                  ) : null}
                </span>
                {h.detail ? <span className="muted small">{h.detail}</span> : null}
                {h.kind !== 'database' ? (
                  <span
                    className="link small"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      st.openTable(h.connectionId, h.database, h.table!);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && st.openTable(h.connectionId, h.database, h.table!)}
                  >
                    browse ›
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DataSearch() {
  const search = useStore((s) => s.search);
  const connections = useStore((s) => s.connections);
  const settings = useStore((s) => s.settings);
  const d = search.data;
  const st = useStore.getState();
  const connected = connections.filter((c) => c.status === 'connected');
  const connectionId = d.connectionId ?? connected[0]?.config.id;
  const dbs = useStore((s) => (connectionId ? s.databases[connectionId] : undefined));
  const tables = useStore((s) => (connectionId && d.database ? s.tables[key(connectionId, d.database)] : undefined));
  const [tableFilter, setTableFilter] = useState('');
  const setData = (patch: Partial<typeof d>) => st.updateSearch((s) => ({ data: { ...s.data, ...patch } }));

  useEffect(() => {
    if (connectionId) void st.loadDatabases(connectionId);
    if (connectionId && d.database) void st.loadTables(connectionId, d.database);
  }, [connectionId, d.database, st]);

  const visibleTables = (tables?.data ?? []).filter((t) => t.name.toLowerCase().includes(tableFilter.toLowerCase()));
  const max = settings.maxTablesPerDataSearch;

  const start = async () => {
    if (!connectionId || !d.database || d.tables.length === 0 || !search.term) return;
    const searchId = uid('ds');
    setData({ searchId, running: true, done: 0, total: d.tables.length, results: [], cancelled: undefined, current: undefined });
    try {
      await rpc({ type: 'searchData', request: { searchId, connectionId, database: d.database, tables: d.tables, term: search.term, match: d.match, perTableLimit: d.perTableLimit } });
    } catch (err) {
      setData({ running: false });
      st.toast('error', errorMessage(err));
    }
  };

  const withHits = d.results.filter((r) => r.rows.length > 0 || r.error);

  return (
    <div className="search-body">
      <div className="data-scope">
        <div className="scope-col">
          <div className="scope-title">1. Scope</div>
          <select aria-label="Connection" value={connectionId ?? ''} onChange={(e) => setData({ connectionId: e.target.value, database: undefined, tables: [] })}>
            {connected.map((c) => (
              <option key={c.config.id} value={c.config.id}>
                {c.config.name}
              </option>
            ))}
          </select>
          <select aria-label="Database" value={d.database ?? ''} onChange={(e) => setData({ database: e.target.value || undefined, tables: [] })}>
            <option value="">Select database…</option>
            {(dbs?.data ?? [])
              .filter((x) => !x.isSystem)
              .map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
          </select>
          <div className="scope-title">2. Options</div>
          <label className="inline">
            Match
            <select value={d.match} onChange={(e) => setData({ match: e.target.value as 'contains' | 'equals' })}>
              <option value="contains">contains (LIKE %term%)</option>
              <option value="equals">equals</option>
            </select>
          </label>
          <label className="inline">
            Rows per table
            <input type="number" className="num-input" min={1} max={1000} value={d.perTableLimit} onChange={(e) => setData({ perTableLimit: Math.max(1, Math.min(1000, Number(e.target.value) || 20)) })} />
          </label>
          <div className="muted small">
            Text columns are matched; numeric columns only when the term is a number. Each table query is bounded by LIMIT and the query timeout ({Math.round(settings.queryTimeoutMs / 1000)}s).
          </div>
        </div>
        <div className="scope-col grow">
          <div className="scope-title">
            3. Tables to search ({d.tables.length}/{max} max)
          </div>
          {d.database ? (
            <>
              <div className="row-gap">
                <input type="search" placeholder="Filter tables…" aria-label="Filter tables" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} />
                <button type="button" className="link small" onClick={() => setData({ tables: [...new Set([...d.tables, ...visibleTables.map((t) => t.name)])].slice(0, max) })}>
                  select visible
                </button>
                <button type="button" className="link small" onClick={() => setData({ tables: [] })}>
                  none
                </button>
              </div>
              {tables?.status === 'loading' ? <Spinner /> : null}
              <div className="table-checks">
                {visibleTables.slice(0, 1000).map((t) => (
                  <label key={t.name} className="check">
                    <input
                      type="checkbox"
                      checked={d.tables.includes(t.name)}
                      disabled={!d.tables.includes(t.name) && d.tables.length >= max}
                      onChange={(e) => setData({ tables: e.target.checked ? [...d.tables, t.name] : d.tables.filter((x) => x !== t.name) })}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div className="muted small">Choose a database first. Data searches never run without an explicit table selection.</div>
          )}
        </div>
      </div>
      <div className="row-gap pad-s">
        {d.running ? (
          <>
            <Spinner label={`Searching ${d.current ?? ''} (${d.done}/${d.total})`} />
            <progress max={d.total} value={d.done} aria-label="Search progress" />
            <button type="button" className="btn small" onClick={() => d.searchId && void rpc({ type: 'cancelSearch', searchId: d.searchId })}>
              <Icon name="stop" /> Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" onClick={() => void start()} disabled={!search.term || !d.database || d.tables.length === 0}>
            <Icon name="search" /> Search {d.tables.length} table(s) for “{search.term}”
          </button>
        )}
        {d.cancelled ? <span className="muted small">Cancelled after {d.done} table(s).</span> : null}
        {!d.running && d.total > 0 && !d.cancelled ? (
          <span className="muted small">
            Done: {withHits.filter((r) => !r.error).length} table(s) with matches out of {d.total}.
          </span>
        ) : null}
      </div>
      <div className="data-results">
        {withHits.map((r) => (
          <div key={r.table} className="result-card">
            <div className="result-card-head">
              <Icon name="table" /> <b>{r.table}</b>
              <span className="muted small">
                {r.database} · {r.rows.length}
                {r.limited ? '+' : ''} match(es) · searched {r.searchedColumns.join(', ') || '—'}
              </span>
              <span className="spacer" />
              {r.searchedColumns.length ? (
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    const g = emptyGroup('or');
                    const children = r.searchedColumns.map((c) => {
                      const cond = newCondition(c, 'text');
                      return { ...cond, operator: d.match === 'equals' ? ('eq' as const) : ('contains' as const), value: search.term };
                    });
                    const filter = { ...g, children };
                    st.openTable(r.connectionId, r.database, r.table, { filter, draftFilter: filter, showFilters: true });
                  }}
                >
                  Open filtered ›
                </button>
              ) : null}
            </div>
            {r.error ? <ErrorBox message={r.error} /> : <DataGrid columns={r.columns.map((c) => ({ name: c.name }))} rows={r.rows} ariaLabel={`Matches in ${r.table}`} />}
          </div>
        ))}
      </div>
    </div>
  );
}
