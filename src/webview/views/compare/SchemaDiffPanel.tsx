import { Fragment, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { DiffStatus, ObjectDiff, SchemaDiff, TableDiff } from '../../../shared/model';
import { Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { rpc } from '../../lib/rpc';
import { useStore } from '../../store';
import { childSummary, diffMarkdown, differing, type SideNames, STATUS_ICON, statusLabel } from './compareUtil';
import { useSideNames } from './compareActions';
import { SyncPanel } from './SyncPanel';

type Filter = 'all' | DiffStatus;

export function DiffBadge({ status, names }: { status: DiffStatus | 'error'; names: SideNames }) {
  return (
    <span className={`diff-badge ds-${status}`}>
      <Icon name={STATUS_ICON[status]} size={11} /> {statusLabel(status, names)}
    </span>
  );
}

function ObjectRows({ items, names, showSame }: { items: ObjectDiff[]; names: SideNames; showSame: boolean }) {
  const shown = showSame ? items : items.filter((d) => d.status !== 'same');
  if (shown.length === 0) return <div className="muted small pad-s">{items.length ? 'No differences.' : 'None on either side.'}</div>;
  return (
    <table className="cmp-objects">
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>{names.source}</th>
          <th>{names.target}</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((d) => (
          <Fragment key={`${d.kind}:${d.name}:${d.targetName ?? ''}`}>
            <tr className={`ds-row-${d.status}`}>
              <td className="mono">
                {d.name}
                {d.targetName ? <span className="muted"> ≈ {d.targetName}</span> : null}
              </td>
              <td>
                <DiffBadge status={d.status} names={names} />
              </td>
              <td className="mono small">{d.source ?? <span className="muted">—</span>}</td>
              <td className="mono small">{d.target ?? <span className="muted">—</span>}</td>
            </tr>
            {d.status === 'changed' ? (
              <tr className="cmp-changes-row">
                <td colSpan={4}>
                  {d.changes.map((c) => (
                    <span key={c.field} className="cmp-change">
                      <strong>{c.field}</strong> <code>{c.source ?? '—'}</code> → <code>{c.target ?? '—'}</code>
                    </span>
                  ))}
                </td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function TableDetail({ table, names }: { table: TableDiff; names: SideNames }) {
  const [showSame, setShowSame] = useState(table.status !== 'changed');
  const sections: [string, ObjectDiff[]][] = [
    ['Columns', table.columns],
    ['Indexes', table.indexes],
    ['Foreign keys', table.foreignKeys],
  ];
  return (
    <div className="cmp-detail">
      <div className="cmp-detail-head">
        <Icon name={table.type === 'view' ? 'view' : 'table'} />
        <strong>{table.name}</strong>
        {table.targetName ? <span className="muted small">({table.targetName} in {names.target})</span> : null}
        <DiffBadge status={table.status} names={names} />
        <span className="spacer" />
        <label className="check small">
          <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />
          show identical objects
        </label>
      </div>
      {table.status === 'only_source' ? <div className="notice wide">This {table.type} exists in {names.source} but not in {names.target}.</div> : null}
      {table.status === 'only_target' ? <div className="notice wide">This {table.type} exists in {names.target} but not in {names.source}.</div> : null}
      {table.changes.length ? (
        <div className="cmp-table-changes">
          {table.changes.map((c) => (
            <span key={c.field} className="cmp-change">
              <strong>table {c.field}</strong> <code>{c.source ?? '—'}</code> → <code>{c.target ?? '—'}</code>
            </span>
          ))}
        </div>
      ) : null}
      {sections.map(([title, items]) => (
        <section key={title} className="cmp-section">
          <h3>
            {title} <span className="muted small">{items.filter((d) => d.status !== 'same').length} different of {items.length}</span>
          </h3>
          <ObjectRows items={items} names={names} showSame={showSame} />
        </section>
      ))}
    </div>
  );
}

export function SchemaDiffPanel({ diff, loading }: { diff: SchemaDiff; loading: boolean }) {
  const names = useSideNames(diff.source, diff.target, 'schema');
  const current = useStore((s) => s.compare);
  const [filter, setFilter] = useState<Filter>('all');
  const [showSame, setShowSame] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | undefined>(() => diff.tables.find(differing)?.name);
  const [tab, setTab] = useState<'details' | 'sync'>('details');
  const [syncTables, setSyncTables] = useState<Set<string>>(() => new Set(diff.tables.filter(differing).map((t) => t.name)));
  const s = diff.summary.tables;
  const identical = s.only_source + s.only_target + s.changed === 0;
  const stale =
    current.source.connectionId !== diff.source.connectionId ||
    current.source.database !== diff.source.database ||
    current.target.connectionId !== diff.target.connectionId ||
    current.target.database !== diff.target.database ||
    JSON.stringify(current.options) !== JSON.stringify(diff.options);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return diff.tables.filter((t) => (filter === 'all' ? showSame || differing(t) : t.status === filter) && (!q || t.name.toLowerCase().includes(q)));
  }, [diff.tables, filter, showSame, search]);
  const table = diff.tables.find((t) => t.name === selected);
  const differingNames = diff.tables.filter(differing).map((t) => t.name);

  const chip = (f: Filter, label: string, n: number) => (
    <button type="button" className={`chip ${filter === f ? 'on' : ''} ${f !== 'all' ? `ds-${f}` : ''}`} aria-pressed={filter === f} disabled={f !== 'all' && n === 0} onClick={() => setFilter(f)}>
      {f !== 'all' ? <Icon name={STATUS_ICON[f]} size={11} /> : null} {label} <span className="pill">{n}</span>
    </button>
  );

  return (
    <div className="cmp-schema">
      <div className="cmp-summary">
        {loading ? <Spinner /> : <Icon name={identical ? 'check' : 'diff'} className={identical ? 'ds-same' : 'ds-changed'} />}
        <strong>
          {names.source} → {names.target}
        </strong>
        <span className="muted small">
          {identical ? 'The schemas are identical' : `${s.only_source + s.only_target + s.changed} of ${diff.tables.length} tables differ`} · compared {new Date(diff.comparedAt).toLocaleTimeString()}
        </span>
        {stale ? <span className="badge warn" title="The selection or options changed since this comparison. Press Compare to refresh.">outdated</span> : null}
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'copyText', text: diffMarkdown(diff, names) })} title="Copy the differences as Markdown">
          <Icon name="copy" /> Copy report
        </button>
      </div>
      <div className="cmp-chips">
        {chip('all', 'All', diff.tables.length)}
        {chip('only_source', `Missing in ${names.target}`, s.only_source)}
        {chip('only_target', `Missing in ${names.source}`, s.only_target)}
        {chip('changed', 'Different', s.changed)}
        {chip('same', 'Identical', s.same)}
        <input type="search" className="cmp-search" placeholder="Filter tables…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter tables" />
        {filter === 'all' ? (
          <label className="check small">
            <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />
            show identical tables
          </label>
        ) : null}
      </div>
      <PanelGroup direction="horizontal" className="cmp-main" autoSaveId="deepdive-compare">
        <Panel defaultSize={36} minSize={20}>
          <div className="cmp-list" role="list" aria-label="Tables">
            {shown.map((t) => (
              <div key={t.name} role="listitem" className={`cmp-row ${selected === t.name ? 'selected' : ''}`}>
                {differing(t) ? (
                  <input
                    type="checkbox"
                    aria-label={`Include ${t.name} in the sync script`}
                    title="Include in the sync script"
                    checked={syncTables.has(t.name)}
                    onChange={(e) =>
                      setSyncTables((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(t.name);
                        else next.delete(t.name);
                        return next;
                      })
                    }
                  />
                ) : (
                  <span className="cmp-check-spacer" />
                )}
                <button
                  type="button"
                  className="cmp-row-main"
                  onClick={() => {
                    setSelected(t.name);
                    setTab('details');
                  }}
                >
                  <Icon name={STATUS_ICON[t.status]} size={12} className={`ds-${t.status}`} title={statusLabel(t.status, names)} />
                  <span className="cmp-name">{t.name}</span>
                  {t.type === 'view' ? <span className="badge">view</span> : null}
                  <span className="muted small cmp-row-sub">{t.status === 'changed' ? childSummary(t) : statusLabel(t.status, names)}</span>
                </button>
              </div>
            ))}
            {shown.length === 0 ? <div className="muted small pad">{identical ? 'Nothing differs. Tick "show identical tables" to browse them.' : 'No table matches the filters.'}</div> : null}
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel defaultSize={64} minSize={30}>
          <div className="cmp-right">
            <div className="tabs small" role="tablist" aria-label="Detail">
              <button type="button" role="tab" aria-selected={tab === 'details'} className={`tab ${tab === 'details' ? 'active' : ''}`} onClick={() => setTab('details')}>
                Details
              </button>
              <button type="button" role="tab" aria-selected={tab === 'sync'} className={`tab ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')} disabled={differingNames.length === 0}>
                Sync script ({differingNames.filter((n) => syncTables.has(n)).length})
              </button>
            </div>
            {tab === 'sync' ? (
              <SyncPanel diff={diff} names={names} tables={differingNames.filter((n) => syncTables.has(n))} />
            ) : table ? (
              <TableDetail key={table.name} table={table} names={names} />
            ) : (
              <div className="muted small pad">Select a table to see its differences.</div>
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
