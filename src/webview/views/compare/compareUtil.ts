import type { DiffStatus, ObjectDiff, SchemaDiff, ServerCompareRow, TableDiff } from '../../../shared/model';
import type { IconName } from '../../components/Icon';

export interface SideNames {
  source: string;
  target: string;
}

export function statusLabel(status: DiffStatus | 'error', names: SideNames): string {
  switch (status) {
    case 'only_source':
      return `Missing in ${names.target}`;
    case 'only_target':
      return `Missing in ${names.source}`;
    case 'changed':
      return 'Different';
    case 'same':
      return 'Identical';
    default:
      return 'Error';
  }
}

export const STATUS_ICON: Record<DiffStatus | 'error', IconName> = {
  only_source: 'arrowDown',
  only_target: 'arrowUp',
  changed: 'warn',
  same: 'check',
  error: 'x',
};

export const differing = (t: TableDiff) => t.status !== 'same';

export const childDiffs = (t: TableDiff): ObjectDiff[] => [...t.columns, ...t.indexes, ...t.foreignKeys].filter((d) => d.status !== 'same');

/** "2 columns, 1 index" — what differs inside a table present on both sides. */
export function childSummary(t: TableDiff): string {
  if (t.status !== 'changed') return t.type === 'view' ? 'view' : `${t.columns.length} columns`;
  const parts: string[] = [];
  const count = (list: ObjectDiff[], one: string, many: string) => {
    const n = list.filter((d) => d.status !== 'same').length;
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  count(t.columns, 'column', 'columns');
  count(t.indexes, 'index', 'indexes');
  count(t.foreignKeys, 'foreign key', 'foreign keys');
  if (t.changes.length) parts.push(t.changes.map((c) => c.field).join(', '));
  return parts.join(', ');
}

const KIND_LABEL: Record<ObjectDiff['kind'], string> = { column: 'Column', index: 'Index', foreignKey: 'Foreign key' };
export const kindLabel = (k: ObjectDiff['kind']) => KIND_LABEL[k];

/** A Markdown report of the differences, for tickets and chat. */
export function diffMarkdown(diff: SchemaDiff, names: SideNames): string {
  const s = diff.summary.tables;
  const lines = [
    `## Schema comparison: ${names.source} → ${names.target}`,
    '',
    `${s.only_source} table(s) missing in ${names.target} · ${s.only_target} missing in ${names.source} · ${s.changed} different · ${s.same} identical`,
    '',
  ];
  for (const t of diff.tables.filter(differing)) {
    lines.push(`### ${t.name}${t.type === 'view' ? ' (view)' : ''} — ${statusLabel(t.status, names)}`);
    for (const c of t.changes) lines.push(`- table ${c.field}: \`${c.source ?? '—'}\` → \`${c.target ?? '—'}\``);
    for (const d of childDiffs(t)) {
      const what = `${kindLabel(d.kind).toLowerCase()} \`${d.name}\``;
      if (d.status === 'changed') lines.push(`- ${what}: ${d.changes.map((c) => `${c.field} \`${c.source ?? '—'}\` → \`${c.target ?? '—'}\``).join('; ')}`);
      else lines.push(`- ${what}: ${statusLabel(d.status, names).toLowerCase()}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function serverCounts(rows: readonly ServerCompareRow[]): Record<DiffStatus | 'error', number> {
  const c = { same: 0, only_source: 0, only_target: 0, changed: 0, error: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}
