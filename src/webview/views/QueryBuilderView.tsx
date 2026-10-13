import {
  Background,
  BackgroundVariant,
  type Connection,
  ConnectionMode,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { memo, useEffect, useMemo, useState } from 'react';
import { Panel as RPanel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { Aggregate, JoinType, QueryModel, QueryTable } from '../../shared/model';
import { ConnectionDatabasePicker, EmptyState, ErrorBox, Spinner } from '../components/common';
import { DataGrid } from '../components/DataGrid';
import { type FilterField, FilterBuilder } from '../components/FilterBuilder';
import { Icon, IconButton } from '../components/Icon';
import { pruneIncomplete } from '../lib/filters';
import { errorMessage, rpc } from '../lib/rpc';
import { useColorMode } from '../lib/theme';
import { useMeasuredNodes } from '../lib/useMeasuredNodes';
import { columnCategory, key, uid } from '../lib/util';
import { emptyModel, useStore } from '../store';
import { addTableToBuilder, resetBuilder, suggestJoins } from './builderActions';

const AGGREGATES: { value: Aggregate | ''; label: string }[] = [
  { value: '', label: '—' },
  { value: 'count', label: 'COUNT' },
  { value: 'count_distinct', label: 'COUNT DISTINCT' },
  { value: 'sum', label: 'SUM' },
  { value: 'avg', label: 'AVG' },
  { value: 'min', label: 'MIN' },
  { value: 'max', label: 'MAX' },
];

function setModel(fn: (m: QueryModel) => QueryModel) {
  useStore.getState().updateBuilder((b) => ({ model: fn(b.model) }));
}

interface QbNodeData extends Record<string, unknown> {
  table: QueryTable;
  connectionId: string;
}

const QbTableNode = memo(function QbTableNode({ data }: NodeProps) {
  const { table, connectionId } = data as QbNodeData;
  const details = useStore((s) => s.details[key(connectionId, table.database, table.table)]);
  const columns = useStore((s) => s.builder.model.columns);
  const selected = new Set(columns.filter((c) => c.source === table.alias).map((c) => c.column));
  const toggle = (column: string) =>
    setModel((m) =>
      selected.has(column)
        ? { ...m, columns: m.columns.filter((c) => !(c.source === table.alias && c.column === column)) }
        : { ...m, columns: [...m.columns, { id: uid('col'), source: table.alias, column }] },
    );
  const fk = new Set(details?.data?.foreignKeys.flatMap((f) => f.columns) ?? []);
  return (
    <div className="qb-node">
      <div className="qb-head">
        <span className="alias">{table.alias}</span>
        <span className="qb-name" title={`${table.database}.${table.table}`}>
          {table.table}
        </span>
        <IconButton
          icon="x"
          label={`Remove ${table.alias}`}
          className="nodrag"
          onClick={() =>
            setModel((m) => ({
              ...m,
              tables: m.tables.filter((t) => t.alias !== table.alias),
              joins: m.joins.filter((j) => j.leftAlias !== table.alias && j.rightAlias !== table.alias),
              columns: m.columns.filter((c) => c.source !== table.alias),
              groupBy: m.groupBy.filter((g) => g.source !== table.alias),
              orderBy: m.orderBy.filter((o) => o.source !== table.alias),
            }))
          }
        />
      </div>
      <label className="qb-col nodrag star">
        <input type="checkbox" checked={selected.has('*')} onChange={() => toggle('*')} />
        <span className="col-name">* (all columns)</span>
      </label>
      {!details || details.status === 'loading' ? <Spinner label="columns…" /> : null}
      {details?.status === 'error' ? <div className="err small pad-s">{details.error}</div> : null}
      {details?.data?.columns.map((c) => (
        <label key={c.name} className="qb-col nodrag" title={`${c.name} ${c.columnType} — drag the dot to another column to join`}>
          <Handle type="source" position={Position.Left} id={`${c.name}::l`} className="qb-handle" />
          <input type="checkbox" checked={selected.has(c.name)} onChange={() => toggle(c.name)} />
          {c.isPrimaryKey ? <Icon name="key" size={10} className="pk" /> : fk.has(c.name) ? <Icon name="link" size={10} className="fk" /> : <span className="col-dot" />}
          <span className="col-name">{c.name}</span>
          <span className="col-type">{c.columnType}</span>
          <Handle type="source" position={Position.Right} id={`${c.name}::r`} className="qb-handle" />
        </label>
      ))}
    </div>
  );
});

const nodeTypes = { qbTable: QbTableNode };

function BuilderCanvas({ connectionId }: { connectionId: string }) {
  const model = useStore((s) => s.builder.model);
  const colorMode = useColorMode();
  const nodes: Node[] = useMemo(
    () => model.tables.map((t, i) => ({ id: `qb:${t.alias}`, type: 'qbTable', position: t.position ?? { x: 40 + i * 300, y: 40 }, data: { table: t, connectionId } satisfies QbNodeData, dragHandle: '.qb-head' })),
    [model.tables, connectionId],
  );
  const edges: Edge[] = useMemo(
    () =>
      model.joins.map((j) => ({
        id: j.id,
        source: `qb:${j.leftAlias}`,
        sourceHandle: `${j.leftColumn}::r`,
        target: `qb:${j.rightAlias}`,
        targetHandle: `${j.rightColumn}::l`,
        label: `${j.type.toUpperCase()} JOIN`,
        type: 'smoothstep',
        className: `qb-edge join-${j.type}`,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { join: j },
      })),
    [model.joins],
  );
  const measured = useMeasuredNodes(nodes);
  const flow = useReactFlow();
  const tableCount = model.tables.length;
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ duration: 300, maxZoom: 1, minZoom: 0.55, padding: 0.12 }), 60);
    return () => clearTimeout(t);
  }, [tableCount, flow]);
  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle || c.source === c.target) return;
    const leftAlias = c.source.slice(3);
    const rightAlias = c.target.slice(3);
    const leftColumn = c.sourceHandle.replace(/::[lr]$/, '');
    const rightColumn = c.targetHandle.replace(/::[lr]$/, '');
    setModel((m) => ({ ...m, joins: [...m.joins, { id: uid('j'), type: 'inner', leftAlias, leftColumn, rightAlias, rightColumn }] }));
  };
  return (
    <ReactFlow
      nodes={measured.nodes}
      onNodesChange={measured.onNodesChange}
      edges={edges}
      nodeTypes={nodeTypes}
      connectionMode={ConnectionMode.Loose}
      onConnect={onConnect}
      colorMode={colorMode}
      fitView
      fitViewOptions={{ maxZoom: 1 }}
      onNodeDragStop={(_, n) => setModel((m) => ({ ...m, tables: m.tables.map((t) => (`qb:${t.alias}` === n.id ? { ...t, position: n.position } : t)) }))}
      onEdgeClick={(_, e) => {
        const order: JoinType[] = ['inner', 'left', 'right'];
        setModel((m) => ({ ...m, joins: m.joins.map((j) => (j.id === e.id ? { ...j, type: order[(order.indexOf(j.type) + 1) % order.length]! } : j)) }));
      }}
      deleteKeyCode={null}
      aria-label="Visual query canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function TablePalette({ connectionId, database }: { connectionId: string; database: string }) {
  const tables = useStore((s) => s.tables[key(connectionId, database)]);
  const [f, setF] = useState('');
  useEffect(() => {
    void useStore.getState().loadTables(connectionId, database);
  }, [connectionId, database]);
  const list = (tables?.data ?? []).filter((t) => t.name.toLowerCase().includes(f.toLowerCase())).slice(0, 500);
  return (
    <div className="palette">
      <div className="palette-head">
        <input type="search" placeholder="Find table…" aria-label="Find table" value={f} onChange={(e) => setF(e.target.value)} />
      </div>
      {tables?.status === 'loading' ? <Spinner label="Loading tables…" /> : null}
      {tables?.status === 'error' ? <ErrorBox message={tables.error ?? ''} /> : null}
      <ul className="palette-list" aria-label="Tables">
        {list.map((t) => (
          <li key={t.name}>
            <button type="button" className="palette-item" title={`Add ${t.name} to the query`} onClick={() => void addTableToBuilder(connectionId, database, t.name)}>
              <Icon name={t.type === 'view' ? 'view' : 'table'} size={12} /> <span>{t.name}</span> <Icon name="plus" size={11} className="add" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ConfigTab = 'columns' | 'filters' | 'sort' | 'joins';

function ConfigPanel({ connectionId }: { connectionId: string }) {
  const model = useStore((s) => s.builder.model);
  const details = useStore((s) => s.details);
  const [tab, setTab] = useState<ConfigTab>('columns');
  const fields: FilterField[] = useMemo(
    () =>
      model.tables.flatMap((t) =>
        (details[key(connectionId, t.database, t.table)]?.data?.columns ?? []).map((c) => ({ source: t.alias, column: c.name, category: columnCategory(c), label: `${t.alias}.${c.name}` })),
      ),
    [model.tables, details, connectionId],
  );
  const [orderPick, setOrderPick] = useState('');
  const [groupPick, setGroupPick] = useState('');
  const parsePick = (v: string) => {
    const [source, column] = v.split('\u0001');
    return source && column ? { source, column } : undefined;
  };
  const move = (i: number, d: number) =>
    setModel((m) => {
      const cols = [...m.columns];
      const j = i + d;
      if (j < 0 || j >= cols.length) return m;
      [cols[i], cols[j]] = [cols[j]!, cols[i]!];
      return { ...m, columns: cols };
    });

  return (
    <div className="qb-config">
      <div className="tabs small" role="tablist">
        {(
          [
            ['columns', `Columns (${model.columns.length})`],
            ['filters', 'Filters'],
            ['sort', 'Sort & group'],
            ['joins', `Joins (${model.joins.length})`],
          ] as [ConfigTab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="qb-config-body">
        {tab === 'columns' ? (
          model.columns.length === 0 ? (
            <div className="muted small pad-s">Tick columns on the canvas. With none selected, the query returns all columns.</div>
          ) : (
            model.columns.map((c, i) => (
              <div key={c.id} className="cfg-row">
                <span className="cfg-label" title={`${c.source}.${c.column}`}>
                  {c.source}.{c.column}
                </span>
                <select
                  aria-label="Aggregate"
                  value={c.aggregate ?? ''}
                  onChange={(e) => setModel((m) => ({ ...m, columns: m.columns.map((x) => (x.id === c.id ? { ...x, aggregate: (e.target.value || undefined) as Aggregate | undefined } : x)) }))}
                >
                  {AGGREGATES.filter((a) => c.column !== '*' || a.value === '' || a.value === 'count').map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Output name"
                  placeholder="as…"
                  className="as-input"
                  value={c.as ?? ''}
                  onChange={(e) => setModel((m) => ({ ...m, columns: m.columns.map((x) => (x.id === c.id ? { ...x, as: e.target.value.replace(/[^A-Za-z0-9_]/g, '') || undefined } : x)) }))}
                />
                <IconButton icon="arrowUp" label="Move up" size={11} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon="arrowDown" label="Move down" size={11} disabled={i === model.columns.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon="x" label="Remove" onClick={() => setModel((m) => ({ ...m, columns: m.columns.filter((x) => x.id !== c.id) }))} />
              </div>
            ))
          )
        ) : null}
        {tab === 'filters' ? (
          fields.length ? (
            <FilterBuilder value={model.filter} onChange={(g) => setModel((m) => ({ ...m, filter: g }))} fields={fields} />
          ) : (
            <div className="muted small pad-s">Add tables first.</div>
          )
        ) : null}
        {tab === 'sort' ? (
          <div>
            <h4>Order by</h4>
            {model.orderBy.map((o, i) => (
              <div key={`${o.source}.${o.column}.${i}`} className="cfg-row">
                <span className="cfg-label">
                  {o.source}.{o.column}
                </span>
                <select
                  aria-label="Direction"
                  value={o.direction}
                  onChange={(e) => setModel((m) => ({ ...m, orderBy: m.orderBy.map((x, k) => (k === i ? { ...x, direction: e.target.value as 'asc' | 'desc' } : x)) }))}
                >
                  <option value="asc">ascending</option>
                  <option value="desc">descending</option>
                </select>
                <IconButton icon="x" label="Remove" onClick={() => setModel((m) => ({ ...m, orderBy: m.orderBy.filter((_, k) => k !== i) }))} />
              </div>
            ))}
            <div className="cfg-row">
              <select aria-label="Add sort column" value={orderPick} onChange={(e) => setOrderPick(e.target.value)}>
                <option value="">Add sort column…</option>
                {fields.map((f) => (
                  <option key={`${f.source}.${f.column}`} value={`${f.source}\u0001${f.column}`}>
                    {f.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn small"
                disabled={!orderPick}
                onClick={() => {
                  const p = parsePick(orderPick);
                  if (p) setModel((m) => ({ ...m, orderBy: [...m.orderBy, { ...p, direction: 'asc' }] }));
                  setOrderPick('');
                }}
              >
                Add
              </button>
            </div>
            <h4>Group by</h4>
            <div className="muted small">Leave empty to group automatically by the non-aggregated columns.</div>
            {model.groupBy.map((g, i) => (
              <div key={`${g.source}.${g.column}`} className="cfg-row">
                <span className="cfg-label">
                  {g.source}.{g.column}
                </span>
                <IconButton icon="x" label="Remove" onClick={() => setModel((m) => ({ ...m, groupBy: m.groupBy.filter((_, k) => k !== i) }))} />
              </div>
            ))}
            <div className="cfg-row">
              <select aria-label="Add group column" value={groupPick} onChange={(e) => setGroupPick(e.target.value)}>
                <option value="">Add group column…</option>
                {fields.map((f) => (
                  <option key={`${f.source}.${f.column}`} value={`${f.source}\u0001${f.column}`}>
                    {f.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn small"
                disabled={!groupPick}
                onClick={() => {
                  const p = parsePick(groupPick);
                  if (p) setModel((m) => ({ ...m, groupBy: [...m.groupBy, p] }));
                  setGroupPick('');
                }}
              >
                Add
              </button>
            </div>
          </div>
        ) : null}
        {tab === 'joins' ? (
          model.joins.length === 0 ? (
            <div className="muted small pad-s">Drag from a column dot to a column in another table to create a join, or use a suggested join from the foreign keys.</div>
          ) : (
            model.joins.map((j) => (
              <div key={j.id} className="cfg-row">
                <span className="cfg-label">
                  {j.leftAlias}.{j.leftColumn} = {j.rightAlias}.{j.rightColumn}
                </span>
                <select aria-label="Join type" value={j.type} onChange={(e) => setModel((m) => ({ ...m, joins: m.joins.map((x) => (x.id === j.id ? { ...x, type: e.target.value as JoinType } : x)) }))}>
                  <option value="inner">INNER</option>
                  <option value="left">LEFT</option>
                  <option value="right">RIGHT</option>
                </select>
                <IconButton icon="x" label="Remove join" onClick={() => setModel((m) => ({ ...m, joins: m.joins.filter((x) => x.id !== j.id) }))} />
              </div>
            ))
          )
        ) : null}
      </div>
    </div>
  );
}

export function QueryBuilderView() {
  const b = useStore((s) => s.builder);
  const active = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const connectionId = b.connectionId ?? (connections.find((c) => c.config.id === active)?.status === 'connected' ? active : undefined);
  const model = b.model;
  useStore((s) => s.details);
  const suggestions = suggestJoins(model, connectionId);

  // Make sure column metadata is available for every table on the canvas.
  useEffect(() => {
    if (!connectionId) return;
    for (const t of model.tables) void useStore.getState().loadDetails(connectionId, t.database, t.table);
  }, [connectionId, model.tables]);

  // Live SQL preview (compiled and validated on the extension host).
  const modelKey = JSON.stringify({ ...model, tables: model.tables.map(({ position: _p, ...t }) => t), filter: pruneIncomplete(model.filter) });
  useEffect(() => {
    if (!connectionId || model.tables.length === 0) {
      useStore.getState().updateBuilder({ sql: undefined, notes: [], previewError: undefined });
      return;
    }
    const handle = setTimeout(() => {
      const m = useStore.getState().builder.model;
      rpc({ type: 'buildQuery', connectionId, model: { ...m, filter: pruneIncomplete(m.filter) } })
        .then((r) => useStore.getState().updateBuilder({ sql: r.displaySql, notes: r.notes, previewError: undefined }))
        .catch((err: unknown) => useStore.getState().updateBuilder({ previewError: errorMessage(err) }));
    }, 250);
    return () => clearTimeout(handle);
  }, [modelKey, connectionId, model.tables.length]);

  const run = async () => {
    if (!connectionId) return;
    const queryId = uid('qb');
    useStore.getState().updateBuilder({ running: true, queryId });
    try {
      const m = useStore.getState().builder.model;
      const res = await rpc({ type: 'runQueryModel', connectionId, queryId, model: { ...m, filter: pruneIncomplete(m.filter) } });
      useStore.getState().updateBuilder({ running: false, result: res.statement, sql: res.built.displaySql, notes: res.built.notes });
    } catch (err) {
      useStore.getState().updateBuilder({ running: false, result: { sql: '', error: errorMessage(err) } });
    }
  };

  const result = b.result?.result;

  return (
    <div className="view builder-view">
      <div className="view-toolbar">
        <ConnectionDatabasePicker
          connectionId={connectionId}
          database={b.database}
          onChange={(c, d) => {
            if (c !== connectionId && model.tables.length) {
              useStore.getState().updateBuilder({ model: emptyModel(), result: undefined });
            }
            useStore.getState().updateBuilder({ connectionId: c, database: d });
          }}
        />
        <label className="inline check">
          <input type="checkbox" checked={model.distinct} onChange={(e) => setModel((m) => ({ ...m, distinct: e.target.checked }))} /> DISTINCT
        </label>
        <label className="inline">
          Limit
          <input
            type="number"
            min={1}
            className="num-input"
            value={model.limit ?? ''}
            placeholder="none"
            onChange={(e) => setModel((m) => ({ ...m, limit: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : null }))}
          />
        </label>
        <span className="spacer" />
        <button type="button" className="btn small ghost" onClick={resetBuilder} disabled={model.tables.length === 0}>
          Clear
        </button>
        <button type="button" className="btn small" disabled={!b.sql} onClick={() => b.sql && useStore.getState().openSqlWith(b.sql, connectionId, b.database)} title="Copy the generated SQL to the SQL editor. The visual query is kept.">
          <Icon name="code" /> Edit as SQL
        </button>
        {b.running ? (
          <button type="button" className="btn small" onClick={() => b.queryId && void rpc({ type: 'cancelQuery', queryId: b.queryId })}>
            <Icon name="stop" /> Cancel
          </button>
        ) : (
          <button type="button" className="btn small primary" disabled={!connectionId || model.tables.length === 0 || Boolean(b.previewError)} onClick={() => void run()}>
            <Icon name="play" /> Run
          </button>
        )}
      </div>
      {!connectionId ? (
        <EmptyState icon="builder" title="Choose a connection">
          Pick a connected server and database above, then add tables to build a query visually.
        </EmptyState>
      ) : (
        <PanelGroup direction="vertical" autoSaveId="deepdive-builder-v">
          <RPanel defaultSize={62} minSize={25}>
            <PanelGroup direction="horizontal" autoSaveId="deepdive-builder-h">
              <RPanel defaultSize={18} minSize={10}>
                {b.database ? <TablePalette connectionId={connectionId} database={b.database} /> : <div className="muted small pad">Select a database to list its tables.</div>}
              </RPanel>
              <PanelResizeHandle className="resize-handle" />
              <RPanel defaultSize={52} minSize={25}>
                <div className="qb-canvas">
                  {suggestions.length ? (
                    <div className="suggestions" aria-label="Suggested joins from foreign keys">
                      <Icon name="sparkle" size={12} /> <span className="muted small">From foreign keys:</span>
                      {suggestions.slice(0, 6).map((s) => (
                        <button key={s.id} type="button" className="chip" onClick={() => setModel((m) => ({ ...m, joins: [...m.joins, s.join] }))}>
                          <Icon name="plus" size={10} /> {s.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {model.tables.length === 0 ? (
                    <EmptyState icon="table" title="Add tables">
                      Click tables in the list on the left (or “Add to query” in the details panel). Tick columns to select them and drag between column dots to join.
                    </EmptyState>
                  ) : (
                    <ReactFlowProvider>
                      <BuilderCanvas connectionId={connectionId} />
                    </ReactFlowProvider>
                  )}
                </div>
              </RPanel>
              <PanelResizeHandle className="resize-handle" />
              <RPanel defaultSize={30} minSize={18}>
                <ConfigPanel connectionId={connectionId} />
              </RPanel>
            </PanelGroup>
          </RPanel>
          <PanelResizeHandle className="resize-handle horizontal" />
          <RPanel defaultSize={38} minSize={15}>
            <div className="qb-bottom">
              <div className="sql-preview">
                {b.previewError ? <ErrorBox message={b.previewError} /> : <pre className="sql-block">{b.sql ?? '-- The generated SQL appears here'}</pre>}
                {b.notes.length ? (
                  <div className="notes">
                    {b.notes.map((n) => (
                      <div key={n} className="muted small">
                        <Icon name="info" size={11} /> {n}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="qb-results">
                {b.running ? <Spinner label="Running…" /> : null}
                {b.result?.error ? <ErrorBox message={b.result.error} /> : null}
                {result ? (
                  <>
                    <div className="muted small result-meta">
                      {result.rows.length} row(s){result.truncated ? ' (truncated by row limit)' : ''} · {result.durationMs} ms
                    </div>
                    <DataGrid columns={result.columns.map((c) => ({ name: c.name, type: c.type }))} rows={result.rows} ariaLabel="Query results" />
                  </>
                ) : null}
              </div>
            </div>
          </RPanel>
        </PanelGroup>
      )}
    </div>
  );
}
