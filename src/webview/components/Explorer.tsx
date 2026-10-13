import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import type { ColumnInfo } from '../../shared/model';
import { formatCount, key } from '../lib/util';
import { type Selection, useStore } from '../store';
import { ConnDot, Spinner } from './common';
import { Icon, IconButton, type IconName } from './Icon';

interface Row {
  id: string;
  level: number;
  kind: 'connection' | 'database' | 'table' | 'column' | 'status';
  label: string;
  icon: IconName;
  expandable: boolean;
  expanded: boolean;
  connectionId: string;
  database?: string;
  table?: string;
  column?: ColumnInfo;
  badge?: string;
  status?: 'loading' | 'error' | 'empty';
  message?: string;
  color?: string;
  parent?: string;
}

const ROW_HEIGHT = 24;

function useRows(filter: string): Row[] {
  const connections = useStore((st) => st.connections);
  const expandedMap = useStore((st) => st.expanded);
  const databases = useStore((st) => st.databases);
  const tablesMap = useStore((st) => st.tables);
  const detailsMap = useStore((st) => st.details);
  const showSystemDatabases = useStore((st) => st.showSystemDatabases);
  return useMemo(() => {
    const s = { connections, expanded: expandedMap, databases, tables: tablesMap, details: detailsMap, showSystemDatabases };
    const rows: Row[] = [];
    const f = filter.trim().toLowerCase();
    for (const c of s.connections) {
      const cid = c.config.id;
      const connKey = `conn:${cid}`;
      const connExpanded = s.expanded[connKey] ?? c.status === 'connected';
      rows.push({
        id: connKey,
        level: 1,
        kind: 'connection',
        label: c.config.name,
        icon: 'server',
        expandable: c.status === 'connected',
        expanded: connExpanded && c.status === 'connected',
        connectionId: cid,
        color: c.config.color,
        badge: c.status === 'connected' ? undefined : c.status,
      });
      if (!(connExpanded && c.status === 'connected')) continue;
      const dbs = s.databases[cid];
      if (!dbs || dbs.status === 'loading') {
        rows.push({ id: `${connKey}:loading`, level: 2, kind: 'status', label: 'Loading databases…', icon: 'info', expandable: false, expanded: false, connectionId: cid, status: 'loading' });
        continue;
      }
      if (dbs.status === 'error') {
        rows.push({ id: `${connKey}:error`, level: 2, kind: 'status', label: dbs.error ?? 'Error', icon: 'warn', expandable: false, expanded: false, connectionId: cid, status: 'error' });
        continue;
      }
      for (const d of dbs.data ?? []) {
        if (d.isSystem && !s.showSystemDatabases) continue;
        const dbKey = `db:${key(cid, d.name)}`;
        const tables = s.tables[key(cid, d.name)];
        const matchingTables = f ? (tables?.data ?? []).filter((t) => t.name.toLowerCase().includes(f)) : undefined;
        if (f && !d.name.toLowerCase().includes(f) && !matchingTables?.length) continue;
        const expanded = Boolean(s.expanded[dbKey]) || Boolean(f && matchingTables?.length);
        rows.push({ id: dbKey, level: 2, kind: 'database', label: d.name, icon: 'database', expandable: true, expanded, connectionId: cid, database: d.name, badge: formatCount(d.tableCount), parent: connKey });
        if (!expanded) continue;
        if (!tables || tables.status === 'loading') {
          rows.push({ id: `${dbKey}:loading`, level: 3, kind: 'status', label: 'Loading tables…', icon: 'info', expandable: false, expanded: false, connectionId: cid, status: 'loading', parent: dbKey });
          continue;
        }
        if (tables.status === 'error') {
          rows.push({ id: `${dbKey}:error`, level: 3, kind: 'status', label: tables.error ?? 'Error', icon: 'warn', expandable: false, expanded: false, connectionId: cid, status: 'error', parent: dbKey });
          continue;
        }
        const list = matchingTables ?? tables.data ?? [];
        if (list.length === 0) {
          rows.push({ id: `${dbKey}:empty`, level: 3, kind: 'status', label: f ? 'No matching tables' : 'No tables', icon: 'info', expandable: false, expanded: false, connectionId: cid, status: 'empty', parent: dbKey });
        }
        for (const t of list) {
          const tKey = `tbl:${key(cid, d.name, t.name)}`;
          const tExpanded = Boolean(s.expanded[tKey]);
          rows.push({
            id: tKey,
            level: 3,
            kind: 'table',
            label: t.name,
            icon: t.type === 'view' ? 'view' : 'table',
            expandable: true,
            expanded: tExpanded,
            connectionId: cid,
            database: d.name,
            table: t.name,
            badge: t.rowEstimate !== undefined ? `≈${formatCount(t.rowEstimate)}` : undefined,
            parent: dbKey,
          });
          if (!tExpanded) continue;
          const details = s.details[key(cid, d.name, t.name)];
          if (!details || details.status === 'loading') {
            rows.push({ id: `${tKey}:loading`, level: 4, kind: 'status', label: 'Loading columns…', icon: 'info', expandable: false, expanded: false, connectionId: cid, status: 'loading', parent: tKey });
            continue;
          }
          if (details.status === 'error') {
            rows.push({ id: `${tKey}:error`, level: 4, kind: 'status', label: details.error ?? 'Error', icon: 'warn', expandable: false, expanded: false, connectionId: cid, status: 'error', parent: tKey });
            continue;
          }
          const fkCols = new Set(details.data!.foreignKeys.flatMap((fk) => fk.columns));
          for (const col of details.data!.columns) {
            rows.push({
              id: `col:${key(cid, d.name, t.name, col.name)}`,
              level: 4,
              kind: 'column',
              label: col.name,
              icon: col.isPrimaryKey ? 'key' : fkCols.has(col.name) ? 'link' : 'column',
              expandable: false,
              expanded: false,
              connectionId: cid,
              database: d.name,
              table: t.name,
              column: col,
              badge: col.columnType,
              parent: tKey,
            });
          }
        }
      }
    }
    return rows;
  }, [connections, expandedMap, databases, tablesMap, detailsMap, showSystemDatabases, filter]);
}

function isSelected(sel: Selection, row: Row): boolean {
  if (!sel || sel.kind === 'relationship') return false;
  if (sel.kind !== row.kind || sel.connectionId !== row.connectionId) return false;
  if (sel.kind === 'database') return sel.database === row.database;
  if (sel.kind === 'table') return sel.database === row.database && sel.table === row.table;
  if (sel.kind === 'column') return sel.database === row.database && sel.table === row.table && sel.column === row.column?.name;
  return true;
}

export function Explorer() {
  const [filter, setFilter] = useState('');
  const rows = useRows(filter);
  const selection = useStore((s) => s.selection);
  const showSystem = useStore((s) => s.showSystemDatabases);
  const [focus, setFocus] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });

  const toggle = (row: Row, value?: boolean) => {
    const st = useStore.getState();
    const next = value ?? !row.expanded;
    st.toggleExpanded(row.id, next);
    if (next && row.kind === 'database') void st.loadTables(row.connectionId, row.database!);
    if (next && row.kind === 'table') void st.loadDetails(row.connectionId, row.database!, row.table!);
    if (next && row.kind === 'connection') void st.loadDatabases(row.connectionId);
  };

  const activate = (row: Row, open = false) => {
    const st = useStore.getState();
    switch (row.kind) {
      case 'connection': {
        st.select({ kind: 'connection', connectionId: row.connectionId });
        const c = st.connections.find((x) => x.config.id === row.connectionId);
        if (open && c && c.status !== 'connected') void st.connect(row.connectionId);
        break;
      }
      case 'database':
        st.select({ kind: 'database', connectionId: row.connectionId, database: row.database! });
        if (open) toggle(row);
        break;
      case 'table':
        st.select({ kind: 'table', connectionId: row.connectionId, database: row.database!, table: row.table! });
        if (open) st.openTable(row.connectionId, row.database!, row.table!);
        break;
      case 'column':
        st.select({ kind: 'column', connectionId: row.connectionId, database: row.database!, table: row.table!, column: row.column!.name });
        break;
      default:
        break;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[focus];
    const move = (i: number) => {
      const n = Math.max(0, Math.min(rows.length - 1, i));
      setFocus(n);
      virtualizer.scrollToIndex(n);
    };
    switch (e.key) {
      case 'ArrowDown':
        move(focus + 1);
        break;
      case 'ArrowUp':
        move(focus - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.expandable && !row.expanded) toggle(row, true);
        else move(focus + 1);
        break;
      case 'ArrowLeft':
        if (row?.expandable && row.expanded) toggle(row, false);
        else if (row?.parent) move(rows.findIndex((r) => r.id === row.parent));
        break;
      case 'Enter':
        if (row) activate(row, true);
        break;
      case ' ':
        if (row) activate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <nav className="explorer" aria-label="Database explorer">
      <div className="panel-header">
        <Icon name="layers" /> <span>Explorer</span>
        <span className="spacer" />
        <IconButton icon="database" label={showSystem ? 'Hide system databases' : 'Show system databases'} active={showSystem} onClick={() => useStore.getState().set({ showSystemDatabases: !showSystem })} />
        <IconButton icon="plus" label="New connection" onClick={() => useStore.getState().set({ connectionForm: { open: true } })} />
      </div>
      <div className="explorer-filter">
        <Icon name="filter" />
        <input type="search" placeholder="Filter loaded tables…" aria-label="Filter explorer" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div
        className="tree"
        ref={parentRef}
        role="tree"
        aria-label="Connections"
        tabIndex={0}
        aria-activedescendant={rows[focus] ? `tree-${rows[focus]!.id}` : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 ? (
          <div className="muted pad">
            No connections yet. Use <b>New connection</b> or <b>Try demo</b>.
          </div>
        ) : null}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]!;
            const selected = isSelected(selection, row);
            return (
              <div
                key={row.id}
                id={`tree-${row.id}`}
                role="treeitem"
                aria-level={row.level}
                aria-expanded={row.expandable ? row.expanded : undefined}
                aria-selected={selected}
                className={`tree-row kind-${row.kind} ${selected ? 'selected' : ''} ${v.index === focus ? 'focused' : ''} ${row.status ?? ''}`}
                style={{ transform: `translateY(${v.start}px)`, paddingLeft: 6 + (row.level - 1) * 14 }}
                onClick={() => {
                  setFocus(v.index);
                  activate(row);
                  if (row.kind === 'database' || (row.kind === 'connection' && row.expandable)) toggle(row);
                }}
                onDoubleClick={() => activate(row, true)}
              >
                <span
                  className="twisty"
                  onClick={(e) => {
                    if (!row.expandable) return;
                    e.stopPropagation();
                    toggle(row);
                  }}
                >
                  {row.expandable ? <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={12} /> : null}
                </span>
                {row.kind === 'connection' ? (
                  <ConnDot color={row.color!} status={useStore.getState().connections.find((c) => c.config.id === row.connectionId)?.status} />
                ) : row.status === 'loading' ? (
                  <Spinner />
                ) : (
                  <Icon name={row.icon} className={`tree-icon ${row.kind}`} />
                )}
                <span className="tree-label" title={row.message ?? row.label}>
                  {row.label}
                </span>
                {row.badge ? <span className="tree-badge">{row.badge}</span> : null}
                <span className="tree-actions">
                  <RowActions row={row} />
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

function RowActions({ row }: { row: Row }) {
  const st = useStore.getState();
  if (row.kind === 'connection') {
    const c = st.connections.find((x) => x.config.id === row.connectionId);
    return c?.status === 'connected' ? (
      <>
        <IconButton icon="refresh" label="Refresh" onClick={() => void st.refreshConnection(row.connectionId)} />
        <IconButton icon="unplug" label="Disconnect" onClick={() => void st.disconnect(row.connectionId)} />
      </>
    ) : (
      <IconButton icon="plug" label="Connect" onClick={() => void st.connect(row.connectionId)} />
    );
  }
  if (row.kind === 'database') {
    return (
      <>
        <IconButton
          icon="schema"
          label="Open schema view"
          onClick={() => {
            st.set((s) => ({ schemaFocus: { ...s.schemaFocus, connectionId: row.connectionId, database: row.database, table: undefined } }));
            st.openTab('schema');
          }}
        />
        <IconButton icon="refresh" label="Reload tables" onClick={() => void st.loadTables(row.connectionId, row.database!, true)} />
      </>
    );
  }
  if (row.kind === 'table') {
    return <IconButton icon="table" label="Browse data" onClick={() => st.openTable(row.connectionId, row.database!, row.table!)} />;
  }
  return null;
}
