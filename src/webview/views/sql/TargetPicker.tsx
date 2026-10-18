import { useEffect, useMemo, useState } from 'react';
import type { TableLocation } from '../../../shared/model';
import { ErrorBox, Spinner } from '../../components/common';
import { Icon } from '../../components/Icon';
import { errorMessage, rpc } from '../../lib/rpc';
import { useStore } from '../../store';
import { nameMatcher } from './multiRunUtil';

/** Chooses the databases a script runs on, by name pattern and by the presence of a table or column. */
export function TargetPicker({ connectionId, onClose }: { connectionId: string; onClose: () => void }) {
  const conn = useStore((s) => s.connections.find((c) => c.config.id === connectionId));
  const dbs = useStore((s) => s.databases[connectionId]);
  const chosen = useStore((s) => s.sql.targets);
  const current = chosen.connectionId === connectionId ? chosen.databases : [];
  const settings = useStore((s) => s.settings);
  const [concurrency, setConcurrency] = useState(() => useStore.getState().sql.concurrency);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(current));
  const [pattern, setPattern] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [table, setTable] = useState('');
  const [column, setColumn] = useState('');
  const [columnMode, setColumnMode] = useState<'has' | 'missing'>('missing');
  const [located, setLocated] = useState<{ table: string; column?: string; hits: TableLocation[] }>();
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void useStore.getState().loadDatabases(connectionId);
  }, [connectionId]);

  const locate = async () => {
    if (!table.trim()) return;
    setLocating(true);
    setError(undefined);
    try {
      const col = column.trim() || undefined;
      const hits = await rpc({ type: 'locateTable', connectionId, table: table.trim(), column: col });
      setLocated({ table: table.trim(), column: col, hits });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLocating(false);
    }
  };

  const shown = useMemo(() => {
    const match = nameMatcher(pattern);
    const allowed = located
      ? new Set(located.hits.filter((h) => located.column === undefined || h.hasColumn === (columnMode === 'has')).map((h) => h.database))
      : undefined;
    return (dbs?.data ?? []).filter((d) => (showSystem || !d.isSystem) && match(d.name) && (!allowed || allowed.has(d.name)));
  }, [dbs?.data, pattern, showSystem, located, columnMode]);

  const allShownSelected = shown.length > 0 && shown.every((d) => selected.has(d.name));
  const toggle = (name: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const setShown = (on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const d of shown) {
        if (on) next.add(d.name);
        else next.delete(d.name);
      }
      return next;
    });

  const apply = () => {
    // Keep the server's database order so the run and the report follow it.
    const order = (dbs?.data ?? []).map((d) => d.name).filter((n) => selected.has(n));
    useStore.getState().updateSql({ targets: { connectionId, databases: order }, concurrency });
    onClose();
  };
  const tooMany = selected.size > settings.multiRunMaxDatabases;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal target-picker" role="dialog" aria-modal="true" aria-labelledby="targets-title" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2 id="targets-title">Run on multiple databases — {conn?.config.name}</h2>
        <div className="target-filters">
          <label className="field">
            Database name
            <input type="search" autoFocus value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. tenant_* — * and % match anything" />
          </label>
          <div className="field">
            Only databases that contain table
            <div className="row">
              <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="table" aria-label="Table name" onKeyDown={(e) => e.key === 'Enter' && void locate()} />
              <input value={column} onChange={(e) => setColumn(e.target.value)} placeholder="column (optional)" aria-label="Column name" onKeyDown={(e) => e.key === 'Enter' && void locate()} />
              {column.trim() ? (
                <div className="segmented" role="radiogroup" aria-label="Column condition">
                  <button type="button" role="radio" aria-checked={columnMode === 'has'} className={columnMode === 'has' ? 'on' : ''} onClick={() => setColumnMode('has')}>
                    has column
                  </button>
                  <button type="button" role="radio" aria-checked={columnMode === 'missing'} className={columnMode === 'missing' ? 'on' : ''} onClick={() => setColumnMode('missing')}>
                    column missing
                  </button>
                </div>
              ) : null}
              <button type="button" className="btn small" disabled={!table.trim() || locating} onClick={() => void locate()}>
                {locating ? <Spinner /> : <Icon name="search" />} Find
              </button>
            </div>
            {located ? (
              <span className="muted small">
                Table <code>{located.table}</code> found in {located.hits.length} database(s)
                {located.column ? `; column ${located.column} ${columnMode === 'has' ? 'present' : 'missing'} in ${located.hits.filter((h) => h.hasColumn === (columnMode === 'has')).length}` : ''}.{' '}
                <button type="button" className="link" onClick={() => setLocated(undefined)}>
                  Clear table filter
                </button>
              </span>
            ) : (
              <span className="muted small">“column missing” is handy for re-runnable migrations such as ADD COLUMN.</span>
            )}
          </div>
        </div>
        {error ? <ErrorBox message={error} /> : null}
        <div className="target-list-head">
          <label className="check">
            <input type="checkbox" checked={allShownSelected} disabled={shown.length === 0} onChange={(e) => setShown(e.target.checked)} />
            {shown.length} shown
          </label>
          <label className="check small">
            <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
            show system databases
          </label>
          <span className="spacer" />
          <button type="button" className="link" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
        <div className="target-list" role="group" aria-label="Databases">
          {dbs?.status === 'loading' && !dbs.data ? <Spinner label="Loading databases…" /> : null}
          {dbs?.error ? <ErrorBox message={dbs.error} /> : null}
          {shown.map((d) => (
            <label key={d.name} className="target-row check">
              <input type="checkbox" checked={selected.has(d.name)} onChange={() => toggle(d.name)} />
              <Icon name="database" size={12} />
              <span className="grow">{d.name}</span>
              <span className="muted small">{d.tableCount} tables</span>
            </label>
          ))}
          {dbs?.data && shown.length === 0 ? <div className="muted small pad">No database matches the filters.</div> : null}
        </div>
        <div className="modal-actions">
          <label className="inline" title="Databases processed at the same time. Keep 1 for schema changes on large tables.">
            Parallel
            <input
              type="number"
              className="num-input"
              min={1}
              max={settings.poolSize}
              value={concurrency}
              onChange={(e) => setConcurrency(Math.min(settings.poolSize, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            />
          </label>
          <span className="spacer" />
          <span className={tooMany ? 'badge danger' : 'muted'}>
            {selected.size} selected{tooMany ? ` — max ${settings.multiRunMaxDatabases}` : ''}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={selected.size === 0 || tooMany} onClick={apply}>
            Use {selected.size} database{selected.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
