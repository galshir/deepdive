import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue } from '../../shared/model';
import { ConnDot, ErrorBox, Spinner } from '../components/common';
import { DataGrid, type GridColumn } from '../components/DataGrid';
import { type FilterField, FilterBuilder } from '../components/FilterBuilder';
import { Icon, IconButton } from '../components/Icon';
import { addChild, countConditions, emptyGroup, newCondition, pruneIncomplete } from '../lib/filters';
import { errorMessage, rpc } from '../lib/rpc';
import { columnCategory, formatCount, key, toJson, toTsv, uid } from '../lib/util';
import { type DataTab, type DataTabState, useStore } from '../store';

const PAGE_SIZES = [50, 100, 250, 500, 1000];

export function TableDataView({ tab }: { tab: DataTab }) {
  const state = useStore((s) => s.dataTabs[tab.id]);
  const conn = useStore((s) => s.connections.find((c) => c.config.id === tab.connectionId));
  const detailsLoad = useStore((s) => s.details[key(tab.connectionId, tab.database, tab.table)]);
  const details = detailsLoad?.data;
  const update = useCallback((p: Partial<DataTabState> | ((s: DataTabState) => Partial<DataTabState>)) => useStore.getState().updateDataTab(tab.id, p), [tab.id]);
  const [showColumns, setShowColumns] = useState(false);
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const lastRequest = useRef(0);

  useEffect(() => {
    void useStore.getState().loadDetails(tab.connectionId, tab.database, tab.table);
  }, [tab.connectionId, tab.database, tab.table]);

  const fetchPage = useCallback(async () => {
    const s = useStore.getState().dataTabs[tab.id];
    if (!s) return;
    const queryId = uid('q');
    const req = ++lastRequest.current;
    update({ loading: true, error: undefined, queryId });
    try {
      const page = await rpc({
        type: 'fetchTableRows',
        connectionId: tab.connectionId,
        queryId,
        query: { database: tab.database, table: tab.table, columns: s.columns, filter: s.filter, sort: s.sort, limit: s.pageSize, offset: s.offset },
      });
      if (req === lastRequest.current) update({ page, loading: false, changes: {}, deletes: [] });
    } catch (err) {
      if (req === lastRequest.current) update({ loading: false, error: errorMessage(err) });
    }
  }, [tab.id, tab.connectionId, tab.database, tab.table, update]);

  // Re-query whenever the applied query parameters change (filters only change on explicit Apply).
  const queryKey = state ? JSON.stringify([state.columns, state.filter, state.sort, state.offset, state.pageSize]) : '';
  const connected = conn?.status === 'connected';
  useEffect(() => {
    if (state && connected) void fetchPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, connected]);

  // "Filter by this column" from the details panel.
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ tab: string; column: string }>).detail;
      if (detail.tab !== tab.id) return;
      addFilterFor(detail.column);
    };
    window.addEventListener('deepdive:addFilter', onAdd);
    return () => window.removeEventListener('deepdive:addFilter', onAdd);
  });

  const fields: FilterField[] = useMemo(() => (details?.columns ?? []).map((c) => ({ column: c.name, category: columnCategory(c), label: `${c.name} · ${c.columnType}` })), [details]);

  if (!state) return null;
  const page = state.page;
  const hasPendingEdits = Object.keys(state.changes).length > 0 || state.deletes.length > 0;
  const readOnlyReason = conn?.config.readOnly
    ? 'This connection is read-only. Edit the connection to allow writes.'
    : details && details.primaryKey.length === 0
      ? 'This table has no primary key, so rows cannot be addressed safely.'
      : details?.table.type === 'view'
        ? 'Views cannot be edited.'
        : undefined;

  function addFilterFor(column: string) {
    const c = useStore.getState().details[key(tab.connectionId, tab.database, tab.table)]?.data?.columns.find((x) => x.name === column);
    const cond = newCondition(column, columnCategory(c));
    update((s) => ({ draftFilter: addChild(s.draftFilter, s.draftFilter.id, cond), showFilters: true }));
  }

  const applyFilter = () => {
    const pruned = pruneIncomplete(state.draftFilter);
    update({ filter: pruned, offset: 0, count: undefined });
  };

  const gridColumns: GridColumn[] = (page?.columns ?? []).map((rc) => {
    const info = details?.columns.find((c) => c.name === rc.name);
    const cat = columnCategory(info);
    return {
      name: rc.name,
      type: info?.columnType ?? rc.type,
      numeric: cat === 'number',
      isPrimaryKey: info?.isPrimaryKey,
      isForeignKey: details?.foreignKeys.some((f) => f.columns.includes(rc.name)),
    };
  });

  const countRows = async () => {
    update({ count: { loading: true } });
    try {
      const r = await rpc({ type: 'countRows', connectionId: tab.connectionId, queryId: uid('c'), database: tab.database, table: tab.table, filter: state.filter });
      update({ count: { loading: false, value: r.count } });
    } catch (err) {
      update({ count: { loading: false, error: errorMessage(err) } });
    }
  };

  const save = async () => {
    if (!page || !details) return;
    const colIndex = new Map(page.columns.map((c, i) => [c.name, i]));
    const keyOf = (row: CellValue[]) => Object.fromEntries(details.primaryKey.map((pk) => [pk, row[colIndex.get(pk) ?? -1] ?? null]));
    const deleteSet = new Set(state.deletes);
    try {
      const res = await rpc({
        type: 'applyEdits',
        connectionId: tab.connectionId,
        database: tab.database,
        table: tab.table,
        updates: Object.entries(state.changes)
          .filter(([r]) => !deleteSet.has(Number(r)))
          .map(([r, changes]) => ({ key: keyOf(page.rows[Number(r)]!), changes })),
        deletes: state.deletes.map((r) => keyOf(page.rows[r]!)),
      });
      useStore.getState().toast(res.committed ? 'success' : 'info', res.message);
      if (res.committed) void fetchPage();
    } catch (err) {
      useStore.getState().toast('error', errorMessage(err));
    }
  };

  const allColumns = details?.columns.map((c) => c.name) ?? [];
  const visibleColumns = state.columns ?? allColumns;
  const filterCount = countConditions(state.filter);
  const draftDirty = JSON.stringify(pruneIncomplete(state.draftFilter)) !== JSON.stringify(state.filter);
  const from = page ? page.offset + 1 : 0;
  const to = page ? page.offset + page.rows.length : 0;

  return (
    <div className="view data-view">
      <div className="view-toolbar">
        {conn ? <ConnDot color={conn.config.color} status={conn.status} /> : null}
        <span className="crumb">
          <span className="muted">{conn?.config.name} ›</span> <span className="muted">{tab.database} ›</span> <b>{tab.table}</b>
        </span>
        {details ? (
          <span className="muted small" title="Estimate from table statistics — not an exact count">
            ≈{formatCount(details.table.rowEstimate)} rows
          </span>
        ) : null}
        <button type="button" className="btn small ghost" onClick={() => void countRows()} disabled={state.count?.loading} title="Runs SELECT COUNT(*) with the current filter">
          {state.count?.loading ? <Spinner /> : <Icon name="sparkle" />}
          {state.count?.value !== undefined ? `${state.count.value.toLocaleString()} rows${filterCount ? ' (filtered)' : ''}` : 'Count rows'}
        </button>
        {state.count?.error ? <span className="err small">{state.count.error}</span> : null}
        <span className="spacer" />
        <button type="button" className={`btn small ${state.showFilters ? 'active' : ''}`} onClick={() => update({ showFilters: !state.showFilters })} aria-expanded={state.showFilters}>
          <Icon name="filter" /> Filters{filterCount ? <span className="pill">{filterCount}</span> : null}
        </button>
        <div className="popover-anchor">
          <button type="button" className={`btn small ${showColumns ? 'active' : ''}`} onClick={() => setShowColumns((v) => !v)} aria-expanded={showColumns}>
            <Icon name="columns" /> Columns{state.columns ? <span className="pill">{state.columns.length}</span> : null}
          </button>
          {showColumns && details ? (
            <ColumnChooser all={allColumns} visible={visibleColumns} onChange={(cols) => update({ columns: cols.length === allColumns.length && cols.every((c, i) => c === allColumns[i]) ? undefined : cols })} onClose={() => setShowColumns(false)} />
          ) : null}
        </div>
        <button type="button" className={`btn small ${state.showSql ? 'active' : ''}`} onClick={() => update({ showSql: !state.showSql })} aria-expanded={state.showSql}>
          <Icon name="code" /> SQL
        </button>
        <button
          type="button"
          className={`btn small ${state.editMode ? 'active warn' : ''}`}
          disabled={Boolean(readOnlyReason)}
          title={readOnlyReason ?? 'Edit cells, then Save to commit in one transaction'}
          onClick={() => update({ editMode: !state.editMode })}
        >
          <Icon name={readOnlyReason ? 'lock' : 'edit'} /> {state.editMode ? 'Editing' : 'Edit'}
        </button>
        <IconButton icon="refresh" label="Reload rows" onClick={() => void fetchPage()} disabled={hasPendingEdits} />
      </div>

      {state.showFilters ? (
        <div className="filter-panel">
          {fields.length ? (
            <FilterBuilder value={state.draftFilter} onChange={(g) => update({ draftFilter: g })} fields={fields} />
          ) : (
            <Spinner label="Loading columns…" />
          )}
          <div className="filter-actions">
            <button type="button" className="btn small primary" onClick={applyFilter} disabled={!draftDirty}>
              <Icon name="play" /> Apply filters
            </button>
            <button type="button" className="btn small ghost" onClick={() => update({ draftFilter: emptyGroup(), filter: emptyGroup(), offset: 0, count: undefined })} disabled={filterCount === 0 && state.draftFilter.children.length === 0}>
              Clear
            </button>
            {draftDirty ? <span className="muted small">Filters changed — apply to run the query.</span> : null}
          </div>
        </div>
      ) : null}

      {state.showSql && page ? (
        <div className="sql-panel">
          <pre className="sql-block" aria-label="Generated SQL">
            {page.displaySql}
          </pre>
          <div className="col-gap">
            <button type="button" className="btn small" onClick={() => useStore.getState().openSqlWith(page.displaySql, tab.connectionId, tab.database)}>
              <Icon name="edit" /> Edit in SQL editor
            </button>
            <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'copyText', text: page.displaySql })}>
              <Icon name="copy" /> Copy
            </button>
            <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'openSqlDocument', sql: page.displaySql })}>
              <Icon name="external" /> Open in VS Code
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid-wrap">
        {!connected ? (
          <ErrorBox message={`${conn?.config.name ?? 'Connection'} is not connected.`} onRetry={() => void useStore.getState().connect(tab.connectionId)} />
        ) : state.error ? (
          <ErrorBox message={state.error} onRetry={() => void fetchPage()} />
        ) : !page ? (
          <div className="center-fill">
            <Spinner label="Loading rows…" />
          </div>
        ) : (
          <DataGrid
            columns={gridColumns}
            rows={page.rows}
            rowOffset={page.offset}
            hiddenColumns={page.hiddenColumns}
            sort={state.sort}
            onSortChange={hasPendingEdits ? undefined : (sort) => update({ sort, offset: 0 })}
            onHeaderFilter={addFilterFor}
            editable={state.editMode && !readOnlyReason}
            changes={state.changes}
            deletes={state.deletes}
            onSelectedRowsChange={setSelectedRows}
            onEditCell={(r, col, value) =>
              update((s) => {
                const original = s.page?.rows[r]?.[s.page.columns.findIndex((c) => c.name === col)];
                const rowChanges = { ...(s.changes[r] ?? {}) };
                if (original === value) delete rowChanges[col];
                else rowChanges[col] = value;
                const changes = { ...s.changes };
                if (Object.keys(rowChanges).length) changes[r] = rowChanges;
                else delete changes[r];
                return { changes };
              })
            }
            emptyMessage={filterCount ? 'No rows match the filters.' : 'This table is empty.'}
            ariaLabel={`Rows of ${tab.table}`}
          />
        )}
        {state.loading && page ? (
          <div className="loading-overlay">
            <Spinner label="Running query…" />
            {state.queryId ? (
              <button type="button" className="btn small" onClick={() => state.queryId && void rpc({ type: 'cancelQuery', queryId: state.queryId })}>
                <Icon name="stop" /> Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {state.editMode && hasPendingEdits ? (
        <div className="edit-bar" role="region" aria-label="Pending changes">
          <Icon name="warn" />
          <span>
            {Object.keys(state.changes).length} row(s) modified, {state.deletes.length} marked for deletion — <b>not saved</b>. Nothing is written until you click Save and confirm.
          </span>
          <span className="spacer" />
          <button type="button" className="btn small ghost" onClick={() => update({ changes: {}, deletes: [] })}>
            <Icon name="undo" /> Discard
          </button>
          <button type="button" className="btn small primary" onClick={() => void save()}>
            <Icon name="save" /> Save…
          </button>
        </div>
      ) : null}

      <div className="status-bar">
        {page ? (
          <span>
            {page.rows.length ? `Rows ${from.toLocaleString()}–${to.toLocaleString()}` : 'No rows'}
            {page.hasMore ? ' · more available' : ''} · {page.durationMs} ms
          </span>
        ) : (
          <span />
        )}
        {state.editMode && selectedRows.length > 0 ? (
          <button
            type="button"
            className="btn small danger"
            onClick={() => update((s) => ({ deletes: [...new Set([...s.deletes, ...selectedRows])] }))}
            title="Marks rows for deletion. Nothing is deleted until you Save and confirm."
          >
            <Icon name="trash" /> Mark {selectedRows.length} row(s) for deletion
          </button>
        ) : null}
        <span className="spacer" />
        {page ? (
          <>
            <IconButton icon="copy" label="Copy page as TSV" onClick={() => void rpc({ type: 'copyText', text: toTsv(page.columns.map((c) => c.name), page.rows) })} />
            <button type="button" className="btn small ghost" onClick={() => void rpc({ type: 'copyText', text: toJson(page.columns.map((c) => c.name), page.rows) })}>
              JSON
            </button>
          </>
        ) : null}
        <label className="inline">
          Page size
          <select value={state.pageSize} disabled={hasPendingEdits} onChange={(e) => update({ pageSize: Number(e.target.value), offset: 0 })}>
            {[...new Set([...PAGE_SIZES, state.pageSize])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <IconButton icon="chevronRight" className="flip" label="Previous page" disabled={state.offset === 0 || hasPendingEdits || state.loading} onClick={() => update((s) => ({ offset: Math.max(0, s.offset - s.pageSize) }))} />
        <span className="muted small">page {Math.floor(state.offset / state.pageSize) + 1}</span>
        <IconButton icon="chevronRight" label="Next page" disabled={!page?.hasMore || hasPendingEdits || state.loading} onClick={() => update((s) => ({ offset: s.offset + s.pageSize }))} />
      </div>
    </div>
  );
}

function ColumnChooser({ all, visible, onChange, onClose }: { all: string[]; visible: string[]; onChange: (cols: string[]) => void; onClose: () => void }) {
  const [order, setOrder] = useState<string[]>(() => [...visible, ...all.filter((c) => !visible.includes(c))]);
  const [on, setOn] = useState<Set<string>>(() => new Set(visible));
  const apply = (o: string[], s: Set<string>) => {
    const cols = o.filter((c) => s.has(c));
    if (cols.length) onChange(cols);
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOrder(next);
    apply(next, on);
  };
  return (
    <div className="popover" role="dialog" aria-label="Choose columns" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="popover-head">
        <b>Columns</b>
        <span className="spacer" />
        <button
          type="button"
          className="link"
          onClick={() => {
            const s = new Set(all);
            setOn(s);
            setOrder(all);
            onChange(all);
          }}
        >
          Show all / reset
        </button>
        <IconButton icon="x" label="Close" onClick={onClose} />
      </div>
      <div className="popover-list">
        {order.map((c, i) => (
          <div key={c} className="chooser-row">
            <label className="check">
              <input
                type="checkbox"
                checked={on.has(c)}
                onChange={(e) => {
                  const s = new Set(on);
                  if (e.target.checked) s.add(c);
                  else if (s.size > 1) s.delete(c);
                  setOn(s);
                  apply(order, s);
                }}
              />
              {c}
            </label>
            <IconButton icon="arrowUp" label={`Move ${c} up`} onClick={() => move(i, -1)} disabled={i === 0} size={11} />
            <IconButton icon="arrowDown" label={`Move ${c} down`} onClick={() => move(i, 1)} disabled={i === order.length - 1} size={11} />
          </div>
        ))}
      </div>
    </div>
  );
}

