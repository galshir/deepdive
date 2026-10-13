import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { ColumnInfo, DatabaseSchema, ForeignKeyInfo, TableInfo } from '../../../shared/model';

export const SCHEMA_W = 250;
const HEADER_H = 34;
const ROW_H = 21;

export interface SchemaTableData extends Record<string, unknown> {
  table: TableInfo;
  columns: ColumnInfo[];
  fkColumns: string[];
  compact: boolean;
  focus: boolean;
  selected: boolean;
  highlight: boolean;
  hiddenColumns: number;
  connectionId: string;
}

export interface SchemaOptions {
  focusTable?: string;
  depth: number;
  compact: boolean;
  hideIsolated: boolean;
  filter: string;
  maxTables: number;
}

export interface SchemaGraph {
  nodes: Node[];
  edges: Edge[];
  total: number;
  shown: number;
  isolatedHidden: number;
  truncated: boolean;
  forcedCompact: boolean;
}

export const fkId = (fk: ForeignKeyInfo) => `${fk.table}::${fk.name}`;

/** Tables reachable from `start` within `depth` FK hops (in either direction). */
function neighbourhood(start: string, depth: number, fks: ForeignKeyInfo[]): Set<string> {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const fk of fks) {
        const other = fk.table === t ? fk.referencedTable : fk.referencedTable === t ? fk.table : undefined;
        if (other && !seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export function buildSchemaGraph(schema: DatabaseSchema, connectionId: string, o: SchemaOptions): SchemaGraph {
  // Only FKs inside this database can be drawn; cross-database references are listed in the details panel.
  const fks = schema.foreignKeys.filter((f) => f.referencedDatabase === schema.database);
  let tables = schema.tables;
  if (o.focusTable) {
    const keep = neighbourhood(o.focusTable, o.depth, fks);
    tables = tables.filter((t) => keep.has(t.name));
  }
  const related = new Set(fks.flatMap((f) => [f.table, f.referencedTable]));
  let isolatedHidden = 0;
  if (o.hideIsolated && !o.focusTable) {
    const before = tables.length;
    tables = tables.filter((t) => related.has(t.name));
    isolatedHidden = before - tables.length;
  }
  const f = o.filter.trim().toLowerCase();
  if (f) tables = tables.filter((t) => t.name.toLowerCase().includes(f));
  const truncated = tables.length > o.maxTables;
  if (truncated) tables = tables.slice(0, o.maxTables);
  const forcedCompact = !o.compact && tables.length > 60;
  const compact = o.compact || forcedCompact;

  const names = new Set(tables.map((t) => t.name));
  const colsByTable = new Map<string, ColumnInfo[]>();
  for (const c of schema.columns) {
    if (!names.has(c.table)) continue;
    const list = colsByTable.get(c.table) ?? [];
    list.push(c);
    colsByTable.set(c.table, list);
  }
  const visibleFks = fks.filter((fk) => names.has(fk.table) && names.has(fk.referencedTable));
  const fkColsByTable = new Map<string, Set<string>>();
  const refColsByTable = new Map<string, Set<string>>();
  for (const fk of fks) {
    fkColsByTable.set(fk.table, new Set([...(fkColsByTable.get(fk.table) ?? []), ...fk.columns]));
    refColsByTable.set(fk.referencedTable, new Set([...(refColsByTable.get(fk.referencedTable) ?? []), ...fk.referencedColumns]));
  }
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeData = new Map<string, SchemaTableData>();
  for (const t of tables) {
    const all = (colsByTable.get(t.name) ?? []).sort((a, b) => a.ordinal - b.ordinal);
    const fkCols = fkColsByTable.get(t.name) ?? new Set<string>();
    const refCols = refColsByTable.get(t.name) ?? new Set<string>();
    const columns = compact ? all.filter((c) => c.isPrimaryKey || fkCols.has(c.name) || refCols.has(c.name)) : all;
    const data: SchemaTableData = {
      table: t,
      columns,
      fkColumns: [...fkCols],
      compact,
      focus: o.focusTable === t.name,
      selected: false,
      highlight: false,
      hiddenColumns: all.length - columns.length,
      connectionId,
    };
    nodeData.set(t.name, data);
    const height = HEADER_H + columns.length * ROW_H + (data.hiddenColumns > 0 ? ROW_H : 0) + 6;
    g.setNode(t.name, { width: SCHEMA_W, height });
  }
  for (const fk of visibleFks) if (fk.table !== fk.referencedTable) g.setEdge(fk.referencedTable, fk.table);
  dagre.layout(g);

  const nodes: Node[] = tables.map((t) => {
    const n = g.node(t.name);
    return { id: `st:${t.name}`, type: 'schemaTable', position: { x: n.x - n.width / 2, y: n.y - n.height / 2 }, data: nodeData.get(t.name)!, width: SCHEMA_W };
  });

  const edges: Edge[] = visibleFks.map((fk) => {
    const sourceData = nodeData.get(fk.table)!;
    const targetData = nodeData.get(fk.referencedTable)!;
    const sCol = fk.columns[0]!;
    const tCol = fk.referencedColumns[0]!;
    return {
      id: `fk:${fkId(fk)}`,
      source: `st:${fk.table}`,
      target: `st:${fk.referencedTable}`,
      sourceHandle: sourceData.columns.some((c) => c.name === sCol) ? `${sCol}::s` : 'header::s',
      targetHandle: targetData.columns.some((c) => c.name === tCol) ? `${tCol}::t` : 'header::t',
      type: 'smoothstep',
      label: fk.cardinality === 'one-to-one' ? '1 : 1' : 'N : 1',
      className: 'schema-edge',
      data: { fk },
    } satisfies Edge;
  });

  return { nodes, edges, total: schema.tables.length, shown: tables.length, isolatedHidden, truncated, forcedCompact };
}

/** Applies selection/hover highlighting without re-running the (expensive) layout. */
export function decorateSchemaGraph(graph: SchemaGraph, h: { selectedTable?: string; selectedFk?: string; hover?: string }): { nodes: Node[]; edges: Edge[] } {
  const active = h.hover ?? h.selectedTable;
  const related = new Set<string>();
  const edges = graph.edges.map((e) => {
    const fk = (e.data as { fk: ForeignKeyInfo }).fk;
    const touches = Boolean(active && (fk.table === active || fk.referencedTable === active));
    const selected = h.selectedFk === fkId(fk);
    if (touches) related.add(fk.table === active ? fk.referencedTable : fk.table);
    const on = touches || selected;
    return on ? { ...e, animated: true, zIndex: 10, className: `schema-edge active ${selected ? 'selected' : ''}` } : e;
  });
  const nodes = graph.nodes.map((n) => {
    const d = n.data as SchemaTableData;
    const selected = d.table.name === h.selectedTable;
    const highlight = related.has(d.table.name);
    return selected || highlight ? { ...n, data: { ...d, selected, highlight } } : n;
  });
  return { nodes, edges };
}
