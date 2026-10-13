import type { Edge, Node } from '@xyflow/react';
import type { ConnectionSummary, DatabaseInfo, DatabaseSchema, TableDetails, TableInfo } from '../../../shared/model';
import { key } from '../../lib/util';
import type { Load, Selection } from '../../store';

export const CONN_D = 128;
export const TABLE_W = 156;
export const TABLE_H = 30;
const SPIRAL_C = 30;
const SPIRAL_STRETCH = 3.3;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const GAP = 48;
const DB_ROW_OFFSET = CONN_D / 2 + 140;

export const dbDiameter = (tableCount: number | undefined) => Math.round(76 + Math.min(84, Math.sqrt(tableCount ?? 0) * 9));

export interface GraphInput {
  connections: ConnectionSummary[];
  databases: Record<string, Load<DatabaseInfo[]>>;
  tables: Record<string, Load<TableInfo[]>>;
  details: Record<string, Load<TableDetails>>;
  schemas: Record<string, Load<DatabaseSchema>>;
  expanded: Record<string, boolean>;
  tableLimit: Record<string, number>;
  defaultTableLimit: number;
  positions: Record<string, { x: number; y: number }>;
  showSystem: boolean;
  showRelations: boolean;
  selection: Selection;
  search: string;
}

export interface ConnNodeData extends Record<string, unknown> {
  summary: ConnectionSummary;
  dbCount?: number;
  loading: boolean;
  selected: boolean;
  dim: boolean;
  shape: 'circle';
}

export interface DbNodeData extends Record<string, unknown> {
  connectionId: string;
  info: DatabaseInfo;
  color: string;
  size: number;
  expanded: boolean;
  loading: boolean;
  error?: string;
  shownTables: number;
  selected: boolean;
  dim: boolean;
  shape: 'circle';
}

export interface TableNodeData extends Record<string, unknown> {
  connectionId: string;
  info: TableInfo;
  color: string;
  expanded: boolean;
  details?: Load<TableDetails>;
  selected: boolean;
  selectedColumn?: string;
  dim: boolean;
  match: boolean;
  shape: 'rect';
}

export interface MoreNodeData extends Record<string, unknown> {
  connectionId: string;
  database: string;
  hidden: number;
  shape: 'rect';
}

/** Offset (relative to the database centre) of the i-th orbiting table, on a stretched sunflower spiral. */
function spiral(i: number, innerRadius: number): { x: number; y: number } {
  const i0 = Math.pow((innerRadius + TABLE_H) / SPIRAL_C, 2);
  const k = i + i0;
  const r = SPIRAL_C * Math.sqrt(k);
  const theta = k * GOLDEN;
  return { x: Math.cos(theta) * r * SPIRAL_STRETCH, y: Math.sin(theta) * r };
}

function footprint(dbSize: number, orbitCount: number): { w: number; h: number } {
  if (orbitCount === 0) return { w: dbSize + GAP, h: dbSize + GAP };
  const outer = spiral(orbitCount - 1, dbSize / 2);
  const r = Math.hypot(outer.x / SPIRAL_STRETCH, outer.y);
  return { w: Math.max(dbSize, 2 * (r * SPIRAL_STRETCH + TABLE_W / 2)) + GAP, h: Math.max(dbSize, 2 * (r + TABLE_H)) + GAP };
}

export function buildGraph(input: GraphInput): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const term = input.search.trim().toLowerCase();
  const sel = input.selection;
  let galaxyX = 0;
  let prevHalf = 0;

  for (const conn of input.connections) {
    const cid = conn.config.id;
    const connId = `conn:${cid}`;
    const connected = conn.status === 'connected';
    const dbs = connected ? input.databases[cid] : undefined;
    const showDbs = connected && (input.expanded[connId] ?? true);
    const visibleDbs = showDbs ? (dbs?.data ?? []).filter((d) => input.showSystem || !d.isSystem) : [];

    // ---- measure each database footprint ----
    const items = visibleDbs.map((d) => {
      const dbKey = key(cid, d.name);
      const expanded = Boolean(input.expanded[`db:${dbKey}`]);
      const tables = input.tables[dbKey];
      const list = expanded && tables?.data ? tables.data : [];
      const limit = input.tableLimit[dbKey] ?? input.defaultTableLimit;
      const shown = list.slice(0, limit);
      const hidden = list.length - shown.length;
      const size = dbDiameter(d.tableCount ?? tables?.data?.length);
      const orbit = shown.length + (hidden > 0 ? 1 : 0);
      return { d, dbKey, expanded, tables, shown, hidden, size, ...footprint(size, orbit) };
    });

    // ---- shelf-pack databases into rows under the connection ----
    const maxRow = Math.max(1100, ...items.map((i) => i.w));
    const rows: (typeof items)[] = [];
    let current: typeof items = [];
    let width = 0;
    for (const it of items) {
      if (current.length && width + it.w > maxRow) {
        rows.push(current);
        current = [];
        width = 0;
      }
      current.push(it);
      width += it.w;
    }
    if (current.length) rows.push(current);
    const galaxyWidth = Math.max(CONN_D + 200, ...rows.map((r) => r.reduce((s, i) => s + i.w, 0)));
    galaxyX += prevHalf + (nodes.length ? 220 : 0) + galaxyWidth / 2;
    prevHalf = galaxyWidth / 2;

    const connMatch = term !== '' && conn.config.name.toLowerCase().includes(term);
    nodes.push({
      id: connId,
      type: 'connection',
      position: input.positions[connId] ?? { x: galaxyX - CONN_D / 2, y: -CONN_D / 2 },
      data: {
        summary: conn,
        dbCount: dbs?.data?.filter((d) => input.showSystem || !d.isSystem).length,
        loading: conn.status === 'connecting' || dbs?.status === 'loading',
        selected: sel?.kind === 'connection' && sel.connectionId === cid,
        dim: term !== '' && !connMatch,
        shape: 'circle',
      } satisfies ConnNodeData,
      width: CONN_D,
      height: CONN_D,
    });

    let y = DB_ROW_OFFSET;
    for (const row of rows) {
      const rowWidth = row.reduce((s, i) => s + i.w, 0);
      const rowHeight = Math.max(...row.map((i) => i.h));
      let x = -rowWidth / 2;
      for (const it of row) {
        const cx = x + it.w / 2;
        const cy = y + rowHeight / 2;
        x += it.w;
        const dbNodeId = `db:${it.dbKey}`;
        const dbMatch = term !== '' && it.d.name.toLowerCase().includes(term);
        const anyTableMatch = term !== '' && it.shown.some((t) => t.name.toLowerCase().includes(term));
        nodes.push({
          id: dbNodeId,
          type: 'database',
          parentId: connId,
          position: input.positions[dbNodeId] ?? { x: CONN_D / 2 + cx - it.size / 2, y: CONN_D / 2 + cy - it.size / 2 },
          data: {
            connectionId: cid,
            info: it.d,
            color: conn.config.color,
            size: it.size,
            expanded: it.expanded,
            loading: it.expanded && it.tables?.status === 'loading',
            error: it.tables?.status === 'error' ? it.tables.error : undefined,
            shownTables: it.shown.length,
            selected: sel?.kind === 'database' && sel.connectionId === cid && sel.database === it.d.name,
            dim: term !== '' && !dbMatch && !anyTableMatch,
            shape: 'circle',
          } satisfies DbNodeData,
          width: it.size,
          height: it.size,
        });
        edges.push({ id: `e:${connId}->${dbNodeId}`, source: connId, target: dbNodeId, type: 'floating', className: 'edge-hierarchy', data: { color: conn.config.color } });

        it.shown.forEach((t, i) => {
          const tKey = key(cid, it.d.name, t.name);
          const tId = `tbl:${tKey}`;
          const off = spiral(i, it.size / 2);
          const match = term !== '' && t.name.toLowerCase().includes(term);
          const selectedTable = (sel?.kind === 'table' || sel?.kind === 'column') && sel.connectionId === cid && sel.database === it.d.name && sel.table === t.name;
          const columnsOpen = Boolean(input.expanded[`gcol:${tKey}`]);
          nodes.push({
            id: tId,
            type: 'table',
            parentId: dbNodeId,
            zIndex: columnsOpen ? 20 : selectedTable ? 10 : undefined,
            position: input.positions[tId] ?? { x: it.size / 2 + off.x - TABLE_W / 2, y: it.size / 2 + off.y - TABLE_H / 2 },
            data: {
              connectionId: cid,
              info: t,
              color: conn.config.color,
              expanded: columnsOpen,
              details: input.details[tKey],
              selected: selectedTable,
              selectedColumn: sel?.kind === 'column' && selectedTable ? sel.column : undefined,
              dim: term !== '' && !match,
              match,
              shape: 'rect',
            } satisfies TableNodeData,
          });
          edges.push({ id: `e:${dbNodeId}->${tId}`, source: dbNodeId, target: tId, type: 'floating', className: 'edge-table', data: { color: conn.config.color } });
        });
        if (it.hidden > 0) {
          const off = spiral(it.shown.length, it.size / 2);
          const mId = `more:${it.dbKey}`;
          nodes.push({
            id: mId,
            type: 'more',
            parentId: dbNodeId,
            position: input.positions[mId] ?? { x: it.size / 2 + off.x - TABLE_W / 2, y: it.size / 2 + off.y - TABLE_H / 2 },
            data: { connectionId: cid, database: it.d.name, hidden: it.hidden, shape: 'rect' } satisfies MoreNodeData,
          });
          edges.push({ id: `e:${dbNodeId}->${mId}`, source: dbNodeId, target: mId, type: 'floating', className: 'edge-table' });
        }

        // Foreign-key edges between visible tables (only real, declared relationships).
        if (input.showRelations && it.expanded) {
          const schema = input.schemas[it.dbKey]?.data;
          const shownNames = new Set(it.shown.map((t) => t.name));
          for (const fk of schema?.foreignKeys ?? []) {
            if (fk.referencedDatabase !== it.d.name || !shownNames.has(fk.table) || !shownNames.has(fk.referencedTable) || fk.table === fk.referencedTable) continue;
            edges.push({
              id: `fk:${it.dbKey}:${fk.table}:${fk.name}`,
              source: `tbl:${key(cid, it.d.name, fk.table)}`,
              target: `tbl:${key(cid, it.d.name, fk.referencedTable)}`,
              type: 'floating',
              className: 'edge-fk',
              data: { fk, connectionId: cid, arrow: true },
            });
          }
        }
      }
      y += rowHeight;
    }
  }
  return { nodes, edges };
}
