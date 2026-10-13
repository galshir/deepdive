import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForeignKeyInfo } from '../../shared/model';
import { EmptyState } from '../components/common';
import { Icon, IconButton } from '../components/Icon';
import { useColorMode } from '../lib/theme';
import { useMeasuredNodes } from '../lib/useMeasuredNodes';
import { key } from '../lib/util';
import { rpc } from '../lib/rpc';
import { useStore } from '../store';
import { FloatingEdge } from './graph/FloatingEdge';
import { buildGraph, type ConnNodeData, type DbNodeData, type MoreNodeData, type TableNodeData } from './graph/layout';
import { nodeTypes } from './graph/nodes';

const edgeTypes = { floating: FloatingEdge };
const MAX_EXPAND_ALL = 20;

function GraphCanvas() {
  const connections = useStore((s) => s.connections);
  const databases = useStore((s) => s.databases);
  const tables = useStore((s) => s.tables);
  const details = useStore((s) => s.details);
  const schemas = useStore((s) => s.schemas);
  const expanded = useStore((s) => s.expanded);
  const tableLimit = useStore((s) => s.tableLimit);
  const positions = useStore((s) => s.positions);
  const showSystem = useStore((s) => s.showSystemDatabases);
  const selection = useStore((s) => s.selection);
  const settings = useStore((s) => s.settings);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const [search, setSearch] = useState('');
  const [showRelations, setShowRelations] = useState(true);
  const flow = useReactFlow();
  const colorMode = useColorMode();
  const pendingFocus = useRef<string[] | null>(null);
  const fittedFor = useRef<string>('');

  // Load databases for every connected server that is shown expanded.
  useEffect(() => {
    for (const c of connections) {
      if (c.status === 'connected' && !databases[c.config.id]) void useStore.getState().loadDatabases(c.config.id);
    }
  }, [connections, databases]);

  // Load FK metadata for expanded databases when relationships are shown.
  useEffect(() => {
    if (!showRelations) return;
    for (const [k, v] of Object.entries(expanded)) {
      if (!v || !k.startsWith('db:')) continue;
      const [cid, db] = k.slice(3).split('\u0001');
      const t = tables[k.slice(3)];
      if (cid && db && t?.status === 'ready' && (t.data?.length ?? 0) <= 400 && !schemas[k.slice(3)]) void useStore.getState().loadSchema(cid, db);
    }
  }, [expanded, tables, schemas, showRelations]);

  const graph = useMemo(
    () =>
      buildGraph({
        connections,
        databases,
        tables,
        details,
        schemas,
        expanded,
        tableLimit,
        defaultTableLimit: settings.maxTablesPerDatabase,
        positions,
        showSystem,
        showRelations,
        selection,
        search,
      }),
    [connections, databases, tables, details, schemas, expanded, tableLimit, settings.maxTablesPerDatabase, positions, showSystem, showRelations, selection, search],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) =>
        e.className === 'edge-fk'
          ? { ...e, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }, interactionWidth: 14 }
          : { ...e, selectable: false, focusable: false, style: { stroke: (e.data as { color?: string } | undefined)?.color } },
      ),
    [graph.edges],
  );

  // Fit to newly expanded content once its tables have loaded.
  useEffect(() => {
    const ids = pendingFocus.current;
    if (!ids) return;
    const present = graph.nodes.filter((n) => ids.some((id) => n.id === id || n.parentId === id));
    if (present.length > 1 || (ids[0] && !ids[0].startsWith('db:'))) {
      pendingFocus.current = null;
      requestAnimationFrame(() => void flow.fitView({ nodes: present.map((n) => ({ id: n.id })), duration: 450, padding: 0.25, maxZoom: 1.2 }));
    }
  }, [graph.nodes, flow]);

  // First time a connection's databases appear, fit the whole canvas.
  useEffect(() => {
    const signature = connections.map((c) => `${c.config.id}:${c.status}:${databases[c.config.id]?.status ?? ''}`).join('|');
    if (signature !== fittedFor.current) {
      fittedFor.current = signature;
      requestAnimationFrame(() => void flow.fitView({ duration: 300, padding: 0.2, maxZoom: 1 }));
    }
  }, [connections, databases, flow]);

  // Center on the active connection when it changes via the toolbar.
  useEffect(() => {
    if (activeConnectionId) {
      const n = graph.nodes.find((x) => x.id === `conn:${activeConnectionId}`);
      if (n) void flow.fitView({ nodes: [{ id: n.id }, ...graph.nodes.filter((x) => x.parentId === n.id).map((x) => ({ id: x.id }))], duration: 400, padding: 0.2, maxZoom: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const st = useStore.getState();
    switch (node.type) {
      case 'connection': {
        const d = node.data as ConnNodeData;
        st.select({ kind: 'connection', connectionId: d.summary.config.id });
        if (d.summary.status === 'error') void st.connect(d.summary.config.id);
        else if (d.summary.status === 'connected') st.toggleExpanded(node.id, !(st.expanded[node.id] ?? true));
        break;
      }
      case 'database': {
        const d = node.data as DbNodeData;
        st.select({ kind: 'database', connectionId: d.connectionId, database: d.info.name });
        const willExpand = !d.expanded;
        st.toggleExpanded(node.id, willExpand);
        if (willExpand) {
          pendingFocus.current = [node.id];
          void st.loadTables(d.connectionId, d.info.name);
        }
        break;
      }
      case 'table': {
        const d = node.data as TableNodeData;
        st.select({ kind: 'table', connectionId: d.connectionId, database: d.info.database, table: d.info.name });
        break;
      }
      case 'more': {
        const d = node.data as MoreNodeData;
        const k = key(d.connectionId, d.database);
        st.set((s) => ({ tableLimit: { ...s.tableLimit, [k]: (s.tableLimit[k] ?? s.settings.maxTablesPerDatabase) + s.settings.maxTablesPerDatabase } }));
        break;
      }
      default:
        break;
    }
  }, []);

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    const st = useStore.getState();
    if (node.type === 'connection') {
      const d = node.data as ConnNodeData;
      if (d.summary.status !== 'connected') void st.connect(d.summary.config.id);
    } else if (node.type === 'table') {
      const d = node.data as TableNodeData;
      st.openTable(d.connectionId, d.info.database, d.info.name);
    }
  }, []);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    const data = edge.data as { fk?: ForeignKeyInfo; connectionId?: string } | undefined;
    if (data?.fk && data.connectionId) useStore.getState().select({ kind: 'relationship', connectionId: data.connectionId, fk: data.fk });
  }, []);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    useStore.getState().set((s) => ({ positions: { ...s.positions, [node.id]: node.position } }));
  }, []);

  const measured = useMeasuredNodes(graph.nodes);

  const matches = useMemo(() => (search.trim() ? graph.nodes.filter((n) => n.type !== 'more' && !(n.data as { dim?: boolean }).dim) : []), [graph.nodes, search]);

  const focusMatches = () => {
    const tableMatches = matches.filter((n) => n.type === 'table' && (n.data as TableNodeData).match);
    const target = tableMatches.length ? tableMatches : matches;
    if (target.length) void flow.fitView({ nodes: target.map((n) => ({ id: n.id })), duration: 400, padding: 0.4, maxZoom: 1.4 });
  };

  const expandAll = (value: boolean) => {
    const st = useStore.getState();
    const patch: Record<string, boolean> = {};
    let n = 0;
    for (const c of st.connections) {
      if (c.status !== 'connected' || (activeConnectionId && c.config.id !== activeConnectionId)) continue;
      for (const d of st.databases[c.config.id]?.data ?? []) {
        if (d.isSystem && !st.showSystemDatabases) continue;
        if (value && n >= MAX_EXPAND_ALL) break;
        patch[`db:${key(c.config.id, d.name)}`] = value;
        if (value) {
          n++;
          void st.loadTables(c.config.id, d.name);
        }
      }
    }
    st.set((s) => ({ expanded: { ...s.expanded, ...patch } }));
    if (value && n >= MAX_EXPAND_ALL) st.toast('info', `Expanded the first ${MAX_EXPAND_ALL} databases to keep the canvas responsive.`);
    requestAnimationFrame(() => setTimeout(() => void flow.fitView({ duration: 400, padding: 0.15 }), 250));
  };

  if (connections.length === 0) {
    return (
      <EmptyState icon="sparkle" title="Welcome to DeepDive">
        <p>Add a MySQL connection to explore your databases as an interactive galaxy of bubbles — or try the offline demo first.</p>
        <div className="row-gap">
          <button type="button" className="btn primary" onClick={() => useStore.getState().set({ connectionForm: { open: true } })}>
            <Icon name="plus" /> New connection
          </button>
          <button type="button" className="btn" onClick={() => void rpc({ type: 'addDemoConnections' })}>
            <Icon name="sparkle" /> Try the demo
          </button>
        </div>
      </EmptyState>
    );
  }

  return (
    <ReactFlow
      nodes={measured.nodes}
      onNodesChange={measured.onNodesChange}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onEdgeClick={onEdgeClick}
      onNodeDragStop={onNodeDragStop}
      colorMode={colorMode}
      minZoom={0.05}
      maxZoom={2.5}
      fitView
      nodesConnectable={false}
      elementsSelectable
      zoomOnDoubleClick={false}
      onlyRenderVisibleElements
      aria-label="Database bubble canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} nodeColor={(n) => ((n.data as { color?: string; summary?: { config: { color: string } } }).color ?? (n.data as { summary?: { config: { color: string } } }).summary?.config.color ?? '#888')} />
      <Controls showInteractive={false} />
      <Panel position="top-left" className="canvas-panel">
        <div className="canvas-search">
          <Icon name="search" />
          <input
            type="search"
            placeholder="Find on canvas…"
            aria-label="Find on canvas"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') focusMatches();
            }}
          />
          {search ? <span className="muted small">{matches.length} match{matches.length === 1 ? '' : 'es'}</span> : null}
        </div>
        {search && matches.length === 0 ? (
          <button
            type="button"
            className="btn small"
            onClick={() => useStore.getState().searchMetadata(search)}
          >
            Search all metadata for “{search}”
          </button>
        ) : null}
        <div className="canvas-tools">
          <IconButton icon="expand" label={`Expand databases${activeConnectionId ? ' of the active connection' : ''}`} onClick={() => expandAll(true)} />
          <IconButton icon="collapse" label="Collapse databases" onClick={() => expandAll(false)} />
          <IconButton icon="link" label={showRelations ? 'Hide foreign-key relationships' : 'Show foreign-key relationships'} active={showRelations} onClick={() => setShowRelations((v) => !v)} />
          <IconButton icon="database" label={showSystem ? 'Hide system databases' : 'Show system databases'} active={showSystem} onClick={() => useStore.getState().set({ showSystemDatabases: !showSystem })} />
          <IconButton icon="refresh" label="Reset layout" onClick={() => useStore.getState().set({ positions: {} })} />
          <IconButton icon="focus" label="Fit to screen" onClick={() => void flow.fitView({ duration: 400, padding: 0.15 })} />
        </div>
      </Panel>
      <Panel position="bottom-left" className="canvas-legend">
        <span>
          <b>Click</b> select / expand
        </span>
        <span>
          <b>Double-click</b> table → data
        </span>
        <span>
          <b>Drag</b> to rearrange
        </span>
      </Panel>
    </ReactFlow>
  );
}

export function GraphView() {
  return (
    <div className="view graph-view">
      <ReactFlowProvider>
        <GraphCanvas />
      </ReactFlowProvider>
    </div>
  );
}
