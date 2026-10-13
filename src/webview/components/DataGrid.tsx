import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, SortSpec } from '../../shared/model';
import { rpc } from '../lib/rpc';
import { cellText, toTsv } from '../lib/util';
import { Icon } from './Icon';

export interface GridColumn {
  name: string;
  type?: string;
  numeric?: boolean;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

interface Pos {
  r: number;
  c: number;
}

export interface DataGridProps {
  columns: GridColumn[];
  rows: CellValue[][];
  /** Index offset shown in the row-number gutter. */
  rowOffset?: number;
  hiddenColumns?: string[];
  sort?: SortSpec[];
  onSortChange?: (sort: SortSpec[]) => void;
  onHeaderFilter?: (column: string) => void;
  editable?: boolean;
  changes?: Record<number, Record<string, CellValue>>;
  deletes?: number[];
  onEditCell?: (row: number, column: string, value: CellValue) => void;
  onSelectedRowsChange?: (rows: number[]) => void;
  emptyMessage?: string;
  ariaLabel?: string;
}

const ROW_HEIGHT = 24;
const GUTTER = 52;

function inRange(p: Pos, a: Pos | null, b: Pos | null): boolean {
  if (!a || !b) return false;
  return p.r >= Math.min(a.r, b.r) && p.r <= Math.max(a.r, b.r) && p.c >= Math.min(a.c, b.c) && p.c <= Math.max(a.c, b.c);
}

export function DataGrid(props: DataGridProps) {
  const { rows, rowOffset = 0, sort = [], editable = false, changes = {}, deletes = [] } = props;
  // Callers often pass freshly mapped arrays; key derived state on content, not identity.
  const signature = JSON.stringify([props.columns, props.hiddenColumns ?? []]);
  const visible = useMemo(() => {
    const hidden = new Set(props.hiddenColumns ?? []);
    return props.columns.map((c, index) => ({ ...c, index })).filter((c) => !hidden.has(c.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const columnDefs = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      visible.map((c) => ({
        id: `${c.index}`,
        header: c.name,
        accessorFn: (row: CellValue[]) => row[c.index],
        size: Math.min(320, Math.max(90, c.name.length * 8 + 40)),
        minSize: 50,
        maxSize: 1200,
      })),
    [visible],
  );

  const table = useReactTable({ data: rows, columns: columnDefs, getCoreRowModel: getCoreRowModel(), columnResizeMode: 'onChange', enableColumnResizing: true });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 20 });
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [focus, setFocus] = useState<Pos | null>(null);
  const [rowSel, setRowSel] = useState<{ from: number; to: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string; isNull: boolean } | null>(null);
  const deleted = useMemo(() => new Set(deletes), [deletes]);

  // Reset selection when the data changes shape.
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setRowSel(null);
    setEditing(null);
  }, [rows, visible]);

  const selectedRows = useMemo(() => {
    if (!rowSel) return [] as number[];
    const out: number[] = [];
    for (let i = Math.min(rowSel.from, rowSel.to); i <= Math.max(rowSel.from, rowSel.to); i++) out.push(i);
    return out;
  }, [rowSel]);
  const onSelectedRowsChange = props.onSelectedRowsChange;
  useEffect(() => onSelectedRowsChange?.(selectedRows), [selectedRows, onSelectedRowsChange]);

  const valueAt = (r: number, c: number): CellValue => {
    const col = visible[c];
    if (!col) return null;
    const change = changes[r];
    if (change && col.name in change) return change[col.name]!;
    return rows[r]?.[col.index] ?? null;
  };

  const copySelection = () => {
    let text = '';
    if (rowSel) {
      text = toTsv(
        visible.map((c) => c.name),
        selectedRows.map((r) => visible.map((_, c) => valueAt(r, c))),
      );
    } else if (anchor && focus) {
      const out: CellValue[][] = [];
      for (let r = Math.min(anchor.r, focus.r); r <= Math.max(anchor.r, focus.r); r++) {
        const line: CellValue[] = [];
        for (let c = Math.min(anchor.c, focus.c); c <= Math.max(anchor.c, focus.c); c++) line.push(valueAt(r, c));
        out.push(line);
      }
      text = toTsv(null, out);
    }
    if (text) void rpc({ type: 'copyText', text });
  };

  const startEdit = (r: number, c: number) => {
    const col = visible[c];
    if (!editable || !col || deleted.has(r)) return;
    const v = valueAt(r, c);
    setEditing({ r, c, value: v === null ? '' : String(v), isNull: v === null });
  };

  const commitEdit = (setNull = false) => {
    if (!editing) return;
    const col = visible[editing.c]!;
    const original = rows[editing.r]?.[col.index] ?? null;
    let v: CellValue = setNull || editing.isNull ? null : editing.value;
    if (typeof v === 'string' && col.numeric && /^-?\d+(\.\d+)?$/.test(v.trim()) && typeof original === 'number') v = Number(v);
    props.onEditCell?.(editing.r, col.name, v);
    setEditing(null);
    scrollRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (rows.length) setRowSel({ from: 0, to: rows.length - 1 });
      return;
    }
    if (!focus) {
      if (rows.length && visible.length && e.key.startsWith('Arrow')) {
        setAnchor({ r: 0, c: 0 });
        setFocus({ r: 0, c: 0 });
        e.preventDefault();
      }
      return;
    }
    const delta: Record<string, Pos> = { ArrowUp: { r: -1, c: 0 }, ArrowDown: { r: 1, c: 0 }, ArrowLeft: { r: 0, c: -1 }, ArrowRight: { r: 0, c: 1 }, PageDown: { r: 20, c: 0 }, PageUp: { r: -20, c: 0 } };
    const d = delta[e.key];
    if (d) {
      e.preventDefault();
      const next = { r: Math.max(0, Math.min(rows.length - 1, focus.r + d.r)), c: Math.max(0, Math.min(visible.length - 1, focus.c + d.c)) };
      setFocus(next);
      if (!e.shiftKey) setAnchor(next);
      setRowSel(null);
      virtualizer.scrollToIndex(next.r);
      return;
    }
    if ((e.key === 'Enter' || e.key === 'F2') && editable) {
      e.preventDefault();
      startEdit(focus.r, focus.c);
    }
    if (e.key === 'Escape') {
      setAnchor(null);
      setFocus(null);
      setRowSel(null);
    }
  };

  const toggleSort = (name: string, multi: boolean) => {
    if (!props.onSortChange) return;
    const existing = sort.find((s) => s.column === name);
    let next: SortSpec[];
    if (!existing) next = multi ? [...sort, { column: name, direction: 'asc' }] : [{ column: name, direction: 'asc' }];
    else if (existing.direction === 'asc') next = sort.map((s) => (s.column === name ? { ...s, direction: 'desc' as const } : s));
    else next = sort.filter((s) => s.column !== name);
    if (!multi && existing) next = next.filter((s) => s.column === name);
    props.onSortChange(next);
  };

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const totalWidth = GUTTER + headers.reduce((w, h) => w + h.getSize(), 0);

  if (visible.length === 0) {
    return <div className="grid-empty muted">{props.emptyMessage ?? 'No columns'}</div>;
  }

  return (
    <div className="grid" ref={scrollRef} tabIndex={0} role="grid" aria-label={props.ariaLabel ?? 'Data grid'} aria-rowcount={rows.length + 1} aria-colcount={visible.length} onKeyDown={onKeyDown}>
      <div className="grid-header" role="row" style={{ width: totalWidth }}>
        <div className="grid-gutter header" style={{ width: GUTTER }} title="Select all rows" onClick={() => rows.length && setRowSel({ from: 0, to: rows.length - 1 })}>
          #
        </div>
        {headers.map((h, ci) => {
          const col = visible[ci]!;
          const s = sort.find((x) => x.column === col.name);
          const sortIndex = sort.length > 1 && s ? sort.indexOf(s) + 1 : undefined;
          return (
            <div
              key={h.id}
              role="columnheader"
              aria-sort={s ? (s.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              className={`grid-hcell ${props.onSortChange ? 'sortable' : ''}`}
              style={{ width: h.getSize() }}
              title={`${col.name}${col.type ? ` · ${col.type}` : ''}${props.onSortChange ? '\nClick to sort, Shift+click to add a sort column' : ''}`}
              onClick={(e) => toggleSort(col.name, e.shiftKey)}
            >
              {col.isPrimaryKey ? <Icon name="key" size={11} className="pk" /> : col.isForeignKey ? <Icon name="link" size={11} className="fk" /> : null}
              <span className="hname">{col.name}</span>
              {col.type ? <span className="htype">{col.type}</span> : null}
              {s ? (
                <span className="sort-ind">
                  <Icon name={s.direction === 'asc' ? 'arrowUp' : 'arrowDown'} size={11} />
                  {sortIndex}
                </span>
              ) : null}
              {props.onHeaderFilter ? (
                <button
                  type="button"
                  className="hfilter"
                  title={`Filter by ${col.name}`}
                  aria-label={`Filter by ${col.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onHeaderFilter!(col.name);
                  }}
                >
                  <Icon name="filter" size={11} />
                </button>
              ) : null}
              <div
                className={`resizer ${h.column.getIsResizing() ? 'resizing' : ''}`}
                onMouseDown={h.getResizeHandler()}
                onTouchStart={h.getResizeHandler()}
                onClick={(e) => e.stopPropagation()}
                role="separator"
                aria-label={`Resize ${col.name}`}
              />
            </div>
          );
        })}
      </div>
      {rows.length === 0 ? <div className="grid-empty muted">{props.emptyMessage ?? 'No rows'}</div> : null}
      <div className="grid-body" style={{ height: virtualizer.getTotalSize(), width: totalWidth }}>
        {virtualizer.getVirtualItems().map((v) => {
          const r = v.index;
          const rowSelected = rowSel !== null && r >= Math.min(rowSel.from, rowSel.to) && r <= Math.max(rowSel.from, rowSel.to);
          return (
            <div
              key={v.key}
              role="row"
              aria-rowindex={r + 2}
              className={`grid-row ${r % 2 ? 'odd' : ''} ${rowSelected ? 'row-selected' : ''} ${deleted.has(r) ? 'deleted' : ''}`}
              style={{ transform: `translateY(${v.start}px)`, width: totalWidth }}
            >
              <div
                className="grid-gutter"
                style={{ width: GUTTER }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  scrollRef.current?.focus();
                  setAnchor(null);
                  setFocus(null);
                  setRowSel((cur) => (e.shiftKey && cur ? { from: cur.from, to: r } : { from: r, to: r }));
                }}
              >
                {rowOffset + r + 1}
              </div>
              {headers.map((h, c) => {
                const col = visible[c]!;
                const value = valueAt(r, c);
                const changed = changes[r] !== undefined && col.name in changes[r]!;
                const isFocus = focus?.r === r && focus.c === c;
                const isEditing = editing?.r === r && editing.c === c;
                return (
                  <div
                    key={h.id}
                    role="gridcell"
                    aria-selected={inRange({ r, c }, anchor, focus)}
                    className={`grid-cell ${col.numeric ? 'num' : ''} ${value === null ? 'null' : ''} ${inRange({ r, c }, anchor, focus) ? 'in-range' : ''} ${isFocus ? 'focus' : ''} ${changed ? 'changed' : ''}`}
                    style={{ width: h.getSize() }}
                    title={value === null ? 'NULL' : String(value).length > 40 ? String(value).slice(0, 2000) : undefined}
                    onMouseDown={(e) => {
                      if (isEditing) return;
                      e.preventDefault();
                      scrollRef.current?.focus();
                      setRowSel(null);
                      setFocus({ r, c });
                      if (!e.shiftKey || !anchor) setAnchor({ r, c });
                    }}
                    onMouseEnter={(e) => {
                      if (e.buttons === 1 && anchor && !editing) setFocus({ r, c });
                    }}
                    onDoubleClick={() => startEdit(r, c)}
                  >
                    {isEditing ? (
                      <span className="cell-editor">
                        <input
                          autoFocus
                          value={editing.isNull ? '' : editing.value}
                          placeholder={editing.isNull ? 'NULL' : ''}
                          aria-label={`Edit ${col.name}`}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value, isNull: false })}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitEdit();
                            if (e.key === 'Escape') {
                              setEditing(null);
                              scrollRef.current?.focus();
                            }
                          }}
                          onBlur={() => commitEdit()}
                        />
                        <button type="button" className="null-btn" title="Set NULL" onMouseDown={(e) => e.preventDefault()} onClick={() => commitEdit(true)}>
                          ∅
                        </button>
                      </span>
                    ) : (
                      cellText(value)
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
