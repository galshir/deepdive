import { useMemo, useState } from 'react';
import type { DiffStatus, ServerCompareRow } from '../../../shared/model';
import { ErrorBox, Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { useStore, type ServerCompareState } from '../../store';
import { serverCounts, STATUS_ICON } from './compareUtil';
import { compareSchemas, useSideNames } from './compareActions';
import { DiffBadge } from './SchemaDiffPanel';

type Filter = 'all' | DiffStatus | 'error';
const ORDER: Record<ServerCompareRow['status'], number> = { error: 0, changed: 1, only_source: 2, only_target: 3, same: 4 };

export function ServerDiffPanel({ server }: { server: ServerCompareState }) {
  const names = useSideNames({ connectionId: server.sourceConnectionId }, { connectionId: server.targetConnectionId }, 'server');
  const [filter, setFilter] = useState<Filter>('all');
  const counts = serverCounts(server.rows);
  const rows = useMemo(
    () => [...server.rows].filter((r) => filter === 'all' || r.status === filter).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.database.localeCompare(b.database)),
    [server.rows, filter],
  );

  const open = (database: string) => {
    const source = { connectionId: server.sourceConnectionId, database };
    const target = { connectionId: server.targetConnectionId, database };
    useStore.getState().updateCompare({ level: 'schema', source, target });
    void compareSchemas(source, target);
  };

  const chip = (f: Filter, label: string, n: number) => (
    <button type="button" className={`chip ${filter === f ? 'on' : ''} ${f !== 'all' ? `ds-${f}` : ''}`} aria-pressed={filter === f} disabled={f !== 'all' && n === 0} onClick={() => setFilter(f)}>
      {f !== 'all' ? <Icon name={STATUS_ICON[f]} size={11} /> : null} {label} <span className="pill">{n}</span>
    </button>
  );

  return (
    <div className="cmp-schema">
      <div className="cmp-summary">
        {server.running ? <Spinner /> : <Icon name="diff" />}
        <strong>
          {names.source} → {names.target}
        </strong>
        <span className="muted small">
          {server.running
            ? `Comparing ${server.done} of ${server.total} shared database(s)${server.current ? ` — ${server.current}` : ''}`
            : `${server.total} shared database(s) compared${server.cancelled ? ' (cancelled)' : ''}`}
        </span>
        {server.running && server.total ? <progress value={server.done} max={server.total} /> : null}
      </div>
      {server.error ? <ErrorBox message={server.error} /> : null}
      <div className="cmp-chips">
        {chip('all', 'All', server.rows.length)}
        {chip('only_source', `Missing in ${names.target}`, counts.only_source)}
        {chip('only_target', `Missing in ${names.source}`, counts.only_target)}
        {chip('changed', 'Different', counts.changed)}
        {chip('same', 'Identical', counts.same)}
        {counts.error ? chip('error', 'Errors', counts.error) : null}
      </div>
      <div className="cmp-server-table">
        <table className="mr-table">
          <thead>
            <tr>
              <th>Database</th>
              <th>Status</th>
              <th className="num">Tables missing in {names.target}</th>
              <th className="num">Tables missing in {names.source}</th>
              <th className="num">Different tables</th>
              <th className="num">Object differences</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r.summary;
              const comparable = r.status === 'changed' || r.status === 'same';
              return (
                <tr key={`${r.status}:${r.database}`} className={comparable ? '' : 'static'} onClick={comparable ? () => open(r.database) : undefined}>
                  <td>{comparable ? <button type="button" className="link">{r.database}</button> : r.database}</td>
                  <td>
                    <DiffBadge status={r.status} names={names} />
                  </td>
                  <td className="num">{s ? s.tables.only_source || '' : ''}</td>
                  <td className="num">{s ? s.tables.only_target || '' : ''}</td>
                  <td className="num">{s ? s.tables.changed || '' : ''}</td>
                  <td className="num">{s ? s.objects.only_source + s.objects.only_target + s.objects.changed || '' : ''}</td>
                  <td className="mr-error-cell" title={r.error}>
                    {r.error ?? (comparable ? <span className="muted small">open →</span> : '')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !server.running ? <div className="muted small pad">No databases to show.</div> : null}
      </div>
    </div>
  );
}
