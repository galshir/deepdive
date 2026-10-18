import type { CellValue, MultiRunFinalStatus, MultiRunStatus, MultiRunTarget, ResultColumn } from '../../../shared/model';
import type { IconName } from '../../components/Icon';
import type { MultiRunView } from '../../store';

export const STATUS_META: Record<MultiRunStatus, { label: string; icon: IconName }> = {
  pending: { label: 'Pending', icon: 'history' },
  running: { label: 'Running', icon: 'play' },
  succeeded: { label: 'Succeeded', icon: 'check' },
  failed: { label: 'Failed', icon: 'x' },
  partial: { label: 'Partial', icon: 'warn' },
  not_run: { label: 'Not run', icon: 'stop' },
};

/** Failures first: they are what the user has to act on. */
const SORT_ORDER: Record<MultiRunStatus, number> = { partial: 0, failed: 1, running: 2, not_run: 3, pending: 4, succeeded: 5 };

export function sortedTargets(view: MultiRunView): MultiRunTarget[] {
  const index = new Map(view.order.map((d, i) => [d, i]));
  return view.order
    .map((d) => view.targets[d]!)
    .filter(Boolean)
    .sort((a, b) => SORT_ORDER[a.status] - SORT_ORDER[b.status] || index.get(a.database)! - index.get(b.database)!);
}

export function liveCounts(view: MultiRunView): Record<MultiRunFinalStatus, number> & { done: number } {
  const c = { succeeded: 0, failed: 0, partial: 0, not_run: 0, done: 0 };
  for (const d of view.order) {
    const t = view.targets[d];
    if (!t || t.status === 'pending' || t.status === 'running') continue;
    c[t.status]++;
    c.done++;
  }
  return c;
}

/**
 * Database name filter. `*` and `%` match any run of characters, `?` and `_` match one; without
 * wildcards the filter matches anywhere in the name. Case-insensitive.
 */
export function nameMatcher(pattern: string): (name: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => true;
  if (!/[*%?_]/.test(p)) {
    const lower = p.toLowerCase();
    return (name) => name.toLowerCase().includes(lower);
  }
  const source = p
    .split('')
    .map((ch) => (ch === '*' || ch === '%' ? '.*' : ch === '?' || ch === '_' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const re = new RegExp(`^${source}$`, 'i');
  return (name) => re.test(name);
}

export const formatDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

export const statementLabel = (statements: string[], index: number, max = 60) => {
  const sql = (statements[index] ?? '').replace(/\s+/g, ' ');
  return `#${index + 1} ${sql.length > max ? `${sql.slice(0, max)}…` : sql}`;
};

export function affectedRows(t: MultiRunTarget): number | undefined {
  let total: number | undefined;
  for (const s of t.statements) if (s.affectedRows !== undefined) total = (total ?? 0) + s.affectedRows;
  return total;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** A Markdown report for pasting into tickets or chat. */
export function reportMarkdown(view: MultiRunView, connectionName: string): string {
  const c = liveCounts(view);
  const s = view.summary;
  const lines = [
    `## Run on ${view.order.length} database(s) of "${connectionName}"`,
    '',
    `${c.succeeded} succeeded · ${c.failed} failed · ${c.partial} partial · ${c.not_run} not run${s.cancelled ? ' · cancelled' : ''}${s.attempt > 1 ? ` · ${s.attempt} attempts` : ''}`,
    '',
    '```sql',
    s.statements.join(';\n') + ';',
    '```',
  ];
  if (s.errorGroups.length) {
    lines.push('', '### Errors');
    for (const g of s.errorGroups) lines.push(`- **${g.code}** ${g.message} — ${g.databases.length} database(s): ${g.databases.join(', ')}`);
  }
  lines.push('', '| Database | Status | Failed statement | Error | Affected rows |', '| --- | --- | --- | --- | --- |');
  for (const t of sortedTargets(view)) {
    const failed = t.failedStatementIndex;
    const st = failed !== undefined ? t.statements[failed] : undefined;
    lines.push(
      `| ${cell(t.database)} | ${STATUS_META[t.status].label} | ${failed !== undefined ? cell(statementLabel(s.statements, failed, 40)) : ''} | ${cell(st?.error ?? '')} | ${affectedRows(t) ?? ''} |`,
    );
  }
  return lines.join('\n');
}

/**
 * When every database returned a result set with the same columns for a statement, the result sets can
 * be shown as one grid with a leading database column. Returns the first such statement.
 */
export function combinedResult(view: MultiRunView): { statementIndex: number; columns: ResultColumn[]; rows: CellValue[][]; truncated: boolean } | undefined {
  const dbs = view.order;
  if (dbs.length < 2) return undefined;
  for (let i = 0; i < view.summary.statements.length; i++) {
    const sets = dbs.map((d) => view.results[d]?.[i]);
    if (sets.some((r) => !r || r.kind !== 'rows')) continue;
    const names = JSON.stringify(sets[0]!.columns.map((c) => c.name));
    if (sets.some((r) => JSON.stringify(r!.columns.map((c) => c.name)) !== names)) continue;
    return {
      statementIndex: i,
      columns: [{ name: 'database' }, ...sets[0]!.columns],
      rows: sets.flatMap((r, j) => r!.rows.map((row) => [dbs[j]!, ...row])),
      truncated: sets.some((r) => r!.truncated),
    };
  }
  return undefined;
}
