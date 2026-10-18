// Pure helpers for running one script on many databases: per-database status, error grouping and
// the run summary. The orchestration (confirmation, execution, events) lives in the router.
import type { MultiRunErrorGroup, MultiRunFinalStatus, MultiRunStatement, MultiRunSummary, MultiRunTarget } from '../../shared/model';

export interface MultiRunState {
  runId: string;
  connectionId: string;
  statements: string[];
  readOnly: boolean[];
  concurrency: number;
  targets: MultiRunTarget[];
  attempt: number;
  running: boolean;
  cancelled: boolean;
  /** Start of the latest attempt. */
  startedAt: number;
  finishedAt?: number;
}

export function newTarget(database: string, statementCount: number): MultiRunTarget {
  return {
    database,
    status: 'pending',
    statements: Array.from({ length: statementCount }, () => ({ status: 'not_run' as const })),
    durationMs: 0,
    attempts: [],
  };
}

/** Index of the first statement that has not been applied yet, or -1 when all were applied. */
export function resumeIndex(target: MultiRunTarget): number {
  return target.statements.findIndex((s) => s.status !== 'ok');
}

/**
 * Final status of a database after an attempt:
 * - succeeded: every statement was applied;
 * - failed: a statement failed and nothing was applied, so the database is unchanged;
 * - partial: some statements were applied before a failure or cancellation;
 * - not_run: nothing was applied and nothing failed (the run was cancelled first).
 */
export function finalStatus(statements: readonly MultiRunStatement[]): { status: MultiRunFinalStatus; failedStatementIndex?: number } {
  const applied = statements.filter((s) => s.status === 'ok').length;
  if (applied === statements.length) return { status: 'succeeded' };
  const failed = statements.findIndex((s) => s.status === 'error');
  if (failed >= 0) return { status: applied > 0 ? 'partial' : 'failed', failedStatementIndex: failed };
  // Cancelled: a partially applied database resumes at its first unapplied statement.
  return applied > 0 ? { status: 'partial', failedStatementIndex: statements.findIndex((s) => s.status !== 'ok') } : { status: 'not_run' };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Makes messages from different databases comparable: drops a leading code and replaces the database name. */
export function normalizeErrorMessage(message: string, code: string, database: string): string {
  let m = message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message;
  if (database) m = m.replace(new RegExp(`\`?${escapeRegExp(database)}\`?(?=[.'"\`\\s]|$)`, 'g'), '<db>');
  return m;
}

/** Groups the failures by error code and message, biggest group first. */
export function groupErrors(targets: readonly MultiRunTarget[]): MultiRunErrorGroup[] {
  const groups = new Map<string, MultiRunErrorGroup>();
  for (const t of targets) {
    if (t.failedStatementIndex === undefined) continue;
    const st = t.statements[t.failedStatementIndex];
    if (!st || st.status !== 'error') continue;
    const code = st.errorCode ?? 'DB_ERROR';
    const message = normalizeErrorMessage(st.error ?? 'Unknown error', code, t.database);
    const k = `${code}\u0000${message}`;
    const g = groups.get(k) ?? { code, message, databases: [] };
    g.databases.push(t.database);
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.databases.length - a.databases.length || a.code.localeCompare(b.code));
}

export function summarize(run: MultiRunState): MultiRunSummary {
  const counts: Record<MultiRunFinalStatus, number> = { succeeded: 0, failed: 0, partial: 0, not_run: 0 };
  for (const t of run.targets) {
    if (t.status === 'pending' || t.status === 'running') counts.not_run++;
    else counts[t.status]++;
  }
  return {
    runId: run.runId,
    connectionId: run.connectionId,
    statements: run.statements,
    total: run.targets.length,
    attempt: run.attempt,
    running: run.running,
    cancelled: run.cancelled,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts,
    errorGroups: groupErrors(run.targets),
  };
}

export function snapshotTarget(t: MultiRunTarget): MultiRunTarget {
  return { ...t, statements: t.statements.map((s) => ({ ...s })), attempts: [...t.attempts] };
}
