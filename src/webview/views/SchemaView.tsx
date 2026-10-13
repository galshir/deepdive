import { Background, BackgroundVariant, Controls, type Edge, Handle, MarkerType, MiniMap, type Node, type NodeProps, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { memo, useEffect, useMemo, useState } from 'react';
import type { ForeignKeyInfo } from '../../shared/model';
import { ConnectionDatabasePicker, EmptyState, ErrorBox, Spinner } from '../components/common';
import { Icon, IconButton } from '../components/Icon';
import { useColorMode } from '../lib/theme';
import { useMeasuredNodes } from '../lib/useMeasuredNodes';
import { formatCount, key } from '../lib/util';
import { useStore } from '../store';
import { buildSchemaGraph, decorateSchemaGraph, fkId, SCHEMA_W, type SchemaTableData } from './schema/layout';

const MAX_TABLES = 300;
const EMPTY: Node[] = [];

// Parents (referenced tables) are ranked left of children, so FK edges leave a child column on its left
// side and enter the referenced column on its right side.
const SchemaTableNode = memo(function SchemaTableNode({ data }: NodeProps) {
  const d = data as SchemaTableData;
  const fk = new Set(d.fkColumns);
  return (
    <div className={`schema-node ${d.focus ? 'is-focus' : ''} ${d.selected ? 'is-selected' : ''} ${d.highlight ? 'is-related' : ''}`} style={{ width: SCHEMA_W }}>
      <div className="schema-head">
        <Handle type="target" id="header::t" position={Position.Right} className="schema-handle" isConnectable={false} />
        <Icon name={d.table.type === 'view' ? 'view' : 'table'} size={13} />
        <span className="schema-name" title={d.table.name}>
          {d.table.name}
        </span>
        {d.table.rowEstimate !== undefined ? <span className="muted small">≈{formatCount(d.table.rowEstimate)}</span> : null}
        <Handle type="source" id="header::s" position={Position.Left} className="schema-handle" isConnectable={false} />
      </div>
      {d.columns.map((c) => (
        <div
          key={c.name}
          className="schema-col nodrag"
          title={`${c.name} ${c.columnType}${c.nullable ? '' : ' NOT NULL'}`}
          onClick={(e) => {
            e.stopPropagation();
            const sel = useStore.getState().schemaFocus;
            if (sel.connectionId && sel.database) useStore.getState().select({ kind: 'column', connectionId: d.connectionId, database: sel.database, table: d.table.name, column: c.name });
          }}
        >
          <Handle type="target" id={`${c.name}::t`} position={Position.Right} className="schema-handle" isConnectable={false} />
          {c.isPrimaryKey ? <Icon name="key" size={11} className="pk" /> : fk.has(c.name) ? <Icon name="link" size={11} className="fk" /> : <span className="col-dot" />}
          <span className={`col-name ${c.isPrimaryKey ? 'is-pk' : ''}`}>{c.name}</span>
          <span className="col-type">
            {c.columnType}
            {c.nullable ? '' : ' ·NN'}
          </span>
          <Handle type="source" id={`${c.name}::s`} position={Position.Left} className="schema-handle" isConnectable={false} />
        </div>
      ))}
      {d.hiddenColumns > 0 ? <div className="schema-more muted small">+{d.hiddenColumns} other columns</div> : null}
    </div>
  );
});

const nodeTypes = { schemaTable: SchemaTableNode };

function SchemaCanvas() {
  const focus = useStore((s) => s.schemaFocus);
  const selection = useStore((s) => s.selection);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const connectionId = focus.connectionId ?? activeConnectionId;
  const schema = useStore((s) => (connectionId && focus.database ? s.schemas[key(connectionId, focus.database)] : undefined));
  const [filter, setFilter] = useState('');
  const [hover, setHover] = useState<string | undefined>();
  const flow = useReactFlow();
  const colorMode = useColorMode();

  useEffect(() => {
    if (connectionId && focus.database) void useStore.getState().loadSchema(connectionId, focus.database);
  }, [connectionId, focus.database]);

  const selectedTable =
    (selection?.kind === 'table' || selection?.kind === 'column') && selection.connectionId === connectionId && selection.database === focus.database ? selection.table : undefined;
  const selectedFk = selection?.kind === 'relationship' ? fkId(selection.fk) : undefined;

  const graph = useMemo(
    () =>
      schema?.data && connectionId
        ? buildSchemaGraph(schema.data, connectionId, {
            focusTable: focus.table,
            depth: focus.depth,
            compact: focus.compact,
            hideIsolated: focus.hideIsolated,
            filter,
            maxTables: MAX_TABLES,
          })
        : undefined,
    [schema?.data, connectionId, focus.table, focus.depth, focus.compact, focus.hideIsolated, filter],
  );
  const decorated = useMemo(() => (graph ? decorateSchemaGraph(graph, { selectedTable, selectedFk, hover }) : undefined), [graph, selectedTable, selectedFk, hover]);

  const measured = useMeasuredNodes(decorated?.nodes ?? EMPTY);
  const edges = useMemo<Edge[]>(() => (decorated?.edges ?? []).map((e) => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } })), [decorated?.edges]);

  const layoutKey = `${focus.database}|${focus.table}|${focus.depth}|${focus.compact}|${focus.hideIsolated}|${filter}|${graph?.shown}`;
  useEffect(() => {
    requestAnimationFrame(() => void flow.fitView({ duration: 300, padding: 0.12, maxZoom: 1.1 }));
  }, [layoutKey, flow]);

  const setFocus = (patch: Partial<typeof focus>) => useStore.getState().set((s) => ({ schemaFocus: { ...s.schemaFocus, ...patch } }));

  const header = (
    <div className="view-toolbar">
      <ConnectionDatabasePicker connectionId={connectionId} database={focus.database} onChange={(c, d) => setFocus({ connectionId: c, database: d, table: undefined })} />
      <div className="segmented" role="radiogroup" aria-label="Schema scope">
        <button type="button" role="radio" aria-checked={!focus.table} className={!focus.table ? 'on' : ''} onClick={() => setFocus({ table: undefined })}>
          Whole database
        </button>
        <button type="button" role="radio" aria-checked={Boolean(focus.table)} className={focus.table ? 'on' : ''} disabled={!focus.table && !selectedTable} onClick={() => setFocus({ table: focus.table ?? selectedTable })}>
          Focus{focus.table ? `: ${focus.table}` : ' selected table'}
        </button>
      </div>
      {focus.table ? (
        <label className="inline">
          Depth
          <select value={focus.depth} onChange={(e) => setFocus({ depth: Number(e.target.value) })}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n} hop{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="inline check">
        <input type="checkbox" checked={focus.compact} onChange={(e) => setFocus({ compact: e.target.checked })} /> Keys only
      </label>
      {!focus.table ? (
        <label className="inline check">
          <input type="checkbox" checked={focus.hideIsolated} onChange={(e) => setFocus({ hideIsolated: e.target.checked })} /> Hide unrelated tables
        </label>
      ) : null}
      <span className="spacer" />
      <IconButton icon="refresh" label="Reload schema" disabled={!connectionId || !focus.database} onClick={() => connectionId && focus.database && void useStore.getState().loadSchema(connectionId, focus.database, true)} />
    </div>
  );

  if (!connectionId || !focus.database) {
    return (
      <>
        {header}
        <EmptyState icon="schema" title="Pick a database">
          Choose a connected server and database to see its tables and foreign-key relationships.
        </EmptyState>
      </>
    );
  }
  if (!schema || schema.status === 'loading') {
    return (
      <>
        {header}
        <div className="center-fill">
          <Spinner label="Reading schema metadata…" />
        </div>
      </>
    );
  }
  if (schema.status === 'error') {
    return (
      <>
        {header}
        <ErrorBox message={schema.error ?? 'Failed to load schema'} onRetry={() => void useStore.getState().loadSchema(connectionId, focus.database!, true)} />
      </>
    );
  }
  const noFks = schema.data!.foreignKeys.length === 0;
  return (
    <>
      {header}
      <div className="schema-canvas">
        {graph && graph.shown === 0 ? (
          <EmptyState icon="table" title={schema.data!.tables.length === 0 ? 'This database has no tables' : 'No tables match'} />
        ) : (
          <ReactFlow
            nodes={measured.nodes}
            onNodesChange={measured.onNodesChange}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={colorMode}
            minZoom={0.05}
            maxZoom={2}
            fitView
            nodesConnectable={false}
            onlyRenderVisibleElements
            onNodeClick={(_, n: Node) => {
              const d = n.data as SchemaTableData;
              useStore.getState().select({ kind: 'table', connectionId, database: focus.database!, table: d.table.name });
            }}
            onNodeDoubleClick={(_, n: Node) => setFocus({ table: (n.data as SchemaTableData).table.name })}
            onNodeMouseEnter={(_, n: Node) => setHover((n.data as SchemaTableData).table.name)}
            onNodeMouseLeave={() => setHover(undefined)}
            onEdgeClick={(_, e: Edge) => {
              const fk = (e.data as { fk?: ForeignKeyInfo } | undefined)?.fk;
              if (fk) useStore.getState().select({ kind: 'relationship', connectionId, fk });
            }}
            aria-label="Schema relationship diagram"
          >
            <Background variant={BackgroundVariant.Lines} gap={40} size={1} />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
            <Panel position="top-left" className="canvas-panel">
              <div className="canvas-search">
                <Icon name="filter" />
                <input type="search" placeholder="Filter tables…" aria-label="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <div className="muted small">
                {graph?.shown} of {graph?.total} tables
                {graph?.isolatedHidden ? ` · ${graph.isolatedHidden} unrelated hidden` : ''}
                {graph?.truncated ? ` · showing first ${MAX_TABLES}, use focus or filter` : ''}
                {graph?.forcedCompact ? ' · keys-only mode for readability' : ''}
              </div>
              {noFks ? (
                <div className="notice small">
                  <Icon name="info" size={12} /> No foreign keys are declared in this database, so no relationships are drawn. DeepDive never guesses relationships.
                </div>
              ) : null}
            </Panel>
            <Panel position="bottom-left" className="canvas-legend">
              <span>
                <Icon name="key" size={11} className="pk" /> primary key
              </span>
              <span>
                <Icon name="link" size={11} className="fk" /> foreign key
              </span>
              <span>arrow → referenced table</span>
              <span>
                <b>Double-click</b> focus table
              </span>
            </Panel>
          </ReactFlow>
        )}
      </div>
    </>
  );
}

export function SchemaView() {
  return (
    <div className="view schema-view">
      <ReactFlowProvider>
        <SchemaCanvas />
      </ReactFlowProvider>
    </div>
  );
}
