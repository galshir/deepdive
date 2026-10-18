import { describe, expect, it } from 'vitest';
import type { DbDriver, QueryOptions } from '../../src/core/drivers/driver';
import { DeepDiveError } from '../../src/core/errors';
import type { Settings } from '../../src/core/settings';
import type { DatabaseInfo, MultiRunSummary, QueryResult } from '../../src/shared/model';
import type { HostEvent } from '../../src/shared/protocol';
import { createHarness, mysqlInput, type Harness } from '../helpers/harness';

type Rule = (sql: string, database: string) => QueryResult | Error | undefined;

/** A "server" with tenant databases whose behaviour per statement and database is scripted by rules. */
class TenantDriver implements DbDriver {
  readonly dialect = 'mysql' as const;
  readonly calls: { sql: string; database?: string }[] = [];
  rules: Rule[] = [];
  delayMs = 0;
  constructor(readonly databases: DatabaseInfo[]) {}
  async connect() {
    return '8.0.36-fake';
  }
  async close() {}
  async listDatabases() {
    return this.databases;
  }
  async listTables() {
    return [];
  }
  async loadTableDetails(): Promise<never> {
    throw new DeepDiveError('nope', 'NOT_FOUND');
  }
  async loadDatabaseSchema(database: string) {
    return { database, tables: [], columns: [], indexes: [], foreignKeys: [] };
  }
  async searchMetadata() {
    return [];
  }
  async locateTable() {
    return [];
  }
  async showCreateTable(): Promise<never> {
    throw new DeepDiveError('nope', 'NOT_FOUND');
  }
  async query(sql: string, _p: unknown, options: QueryOptions): Promise<QueryResult> {
    this.calls.push({ sql, database: options.database });
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DeepDiveError('Query cancelled', 'CANCELLED'));
        });
      });
    }
    for (const rule of this.rules) {
      const r = rule(sql, options.database ?? '');
      if (r instanceof Error) throw r;
      if (r) return r;
    }
    return /^\s*SELECT/i.test(sql)
      ? { kind: 'rows', columns: [{ name: 'n' }], rows: [[options.database ?? null]], truncated: false, durationMs: 1 }
      : { kind: 'ok', columns: [], rows: [], truncated: false, affectedRows: 1, durationMs: 1 };
  }
  async transaction() {
    return [];
  }
}

const tenants = ['t1', 't2', 't3', 't4', 't5'];
const dbInfo = (name: string, isSystem = false): DatabaseInfo => ({ name, isSystem, tableCount: 1 });

const mysqlError = (code: string, message: string) => new DeepDiveError(`${code}: ${message}`, 'DB_ERROR', code);

async function setup(patch: Record<string, unknown> = {}, settings: Partial<Settings> = {}) {
  let driver!: TenantDriver;
  const h = await createHarness({
    settings,
    factory: () => {
      driver = new TenantDriver([...tenants.map((t) => dbInfo(t)), dbInfo('mysql', true)]);
      return driver;
    },
  });
  const conn = await h.call({ type: 'saveConnection', config: mysqlInput({ readOnly: false, ...patch }) });
  await h.call({ type: 'connect', connectionId: conn.config.id });
  return { h, connectionId: conn.config.id, driver: () => driver };
}

let seq = 0;
const runId = () => `run_${++seq}`;

async function finished(h: Harness, id: string, attempt = 1): Promise<MultiRunSummary> {
  for (let i = 0; i < 400; i++) {
    const e = h.events.find((x): x is Extract<HostEvent, { type: 'multiRunFinished' }> => x.type === 'multiRunFinished' && x.summary.runId === id && x.summary.attempt === attempt);
    if (e) return e.summary;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${id} attempt ${attempt} did not finish`);
}

const latestTargets = (h: Harness, id: string) => {
  const map = new Map<string, Extract<HostEvent, { type: 'multiRunProgress' }>['progress']>();
  for (const e of h.events) if (e.type === 'multiRunProgress' && e.progress.runId === id) map.set(e.progress.target.database, e.progress);
  return map;
};

describe('running a script on multiple databases', () => {
  it('runs read-only scripts without confirmation and reports each database', async () => {
    const { h, connectionId, driver } = await setup();
    const id = runId();
    const snap = await h.call({ type: 'runSqlMulti', connectionId, runId: id, sql: 'SELECT COUNT(*) FROM users', databases: tenants, concurrency: 2 });
    expect(snap.targets.map((t) => t.status)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    const summary = await finished(h, id);
    expect(h.confirms).toEqual([]);
    expect(summary.counts).toEqual({ succeeded: 5, failed: 0, partial: 0, not_run: 0 });
    expect(driver().calls.map((c) => c.database).sort()).toEqual(tenants);
    const progress = latestTargets(h, id);
    expect(progress.get('t3')!.results![0]!.rows).toEqual([['t3']]);
  });

  it('skips failing databases, continues, and groups the errors', async () => {
    const { h, connectionId, driver } = await setup();
    const id = runId();
    driver().rules = [
      (_sql, db) => (db === 't2' || db === 't4' ? mysqlError('ER_DUP_FIELDNAME', "Duplicate column name 'is_active'") : undefined),
      (_sql, db) => (db === 't5' ? mysqlError('ER_NO_SUCH_TABLE', `Table '${db}.users' doesn't exist`) : undefined),
    ];
    await h.call({ type: 'runSqlMulti', connectionId, runId: id, sql: 'ALTER TABLE users ADD COLUMN is_active TINYINT', databases: tenants, concurrency: 1 });
    const summary = await finished(h, id);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toMatch(/Run 1 write statement\(s\) on 5 database\(s\)/);
    expect(driver().calls).toHaveLength(5);
    expect(summary.counts).toEqual({ succeeded: 2, failed: 3, partial: 0, not_run: 0 });
    expect(summary.errorGroups).toEqual([
      { code: 'ER_DUP_FIELDNAME', message: "Duplicate column name 'is_active'", databases: ['t2', 't4'] },
      { code: 'ER_NO_SUCH_TABLE', message: "Table '<db>.users' doesn't exist", databases: ['t5'] },
    ]);
    const t5 = latestTargets(h, id).get('t5')!.target;
    expect(t5).toMatchObject({ status: 'failed', failedStatementIndex: 0 });
    expect(t5.statements[0]).toMatchObject({ status: 'error', errorCode: 'ER_NO_SUCH_TABLE' });
  });

  it('marks partially applied databases and retries them from the failed statement', async () => {
    const { h, connectionId, driver } = await setup();
    const id = runId();
    const sql = 'ALTER TABLE users ADD COLUMN a INT; ALTER TABLE users ADD INDEX ia (a); UPDATE users SET a = 1';
    let indexBroken = true;
    driver().rules = [
      (s, db) => (db === 't2' && s.includes('ADD INDEX') && indexBroken ? mysqlError('ER_LOCK_WAIT_TIMEOUT', 'Lock wait timeout exceeded') : undefined),
      (s, db) => (db === 't3' && s.includes('ADD COLUMN') ? mysqlError('ER_NO_SUCH_TABLE', "Table 't3.users' doesn't exist") : undefined),
    ];
    await h.call({ type: 'runSqlMulti', connectionId, runId: id, sql, databases: ['t1', 't2', 't3'], concurrency: 1 });
    const first = await finished(h, id);
    expect(first.counts).toEqual({ succeeded: 1, failed: 1, partial: 1, not_run: 0 });
    const t2 = latestTargets(h, id).get('t2')!.target;
    expect(t2.status).toBe('partial');
    expect(t2.failedStatementIndex).toBe(1);
    expect(t2.statements.map((s) => s.status)).toEqual(['ok', 'error', 'not_run']);

    indexBroken = false;
    driver().calls.length = 0;
    h.confirms.length = 0;
    const retry = await h.call({ type: 'retryMultiRun', runId: id, mode: 'partial' });
    expect(retry.summary.attempt).toBe(2);
    expect(retry.targets.find((t) => t.database === 't2')!.status).toBe('pending');
    const second = await finished(h, id, 2);
    expect(h.confirms[0]).toMatch(/on 1 database/);
    // Only the failed statement and the ones after it ran, on t2 only.
    expect(driver().calls).toEqual([
      { sql: 'ALTER TABLE users ADD INDEX ia (a)', database: 't2' },
      { sql: 'UPDATE users SET a = 1', database: 't2' },
    ]);
    expect(second.counts).toEqual({ succeeded: 2, failed: 1, partial: 0, not_run: 0 });
    const t2After = latestTargets(h, id).get('t2')!.target;
    expect(t2After.attempts.map((a) => a.status)).toEqual(['partial', 'succeeded']);
    expect(t2After.statements[0]!.attempt).toBe(1);
    expect(t2After.statements[1]!.attempt).toBe(2);

    // "Retry failed" re-runs the whole script on unchanged databases.
    driver().calls.length = 0;
    driver().rules = [];
    await h.call({ type: 'retryMultiRun', runId: id, mode: 'failed' });
    const third = await finished(h, id, 3);
    expect(driver().calls.map((c) => c.database)).toEqual(['t3', 't3', 't3']);
    expect(third.counts.succeeded).toBe(3);
    await expect(h.call({ type: 'retryMultiRun', runId: id, mode: 'failed' })).rejects.toThrow(/Nothing to retry/);
  });

  it('cancels between databases and lets the rest be retried', async () => {
    const { h, connectionId, driver } = await setup();
    const id = runId();
    driver().delayMs = 20;
    await h.call({ type: 'runSqlMulti', connectionId, runId: id, sql: 'SELECT 1', databases: tenants, concurrency: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(await h.call({ type: 'cancelMultiRun', runId: id })).toBe(true);
    const summary = await finished(h, id);
    expect(summary.cancelled).toBe(true);
    expect(summary.counts.not_run).toBeGreaterThan(0);
    expect(summary.counts.succeeded + summary.counts.not_run).toBe(5);
    driver().delayMs = 0;
    await h.call({ type: 'retryMultiRun', runId: id, mode: 'failed' });
    expect((await finished(h, id, 2)).counts.succeeded).toBe(5);
  });

  it('validates the script and the targets', async () => {
    const { h, connectionId } = await setup();
    const preview = await h.call({ type: 'previewMultiRun', connectionId, sql: 'USE t1; SELECT * FROM t1.users', databases: ['t1', 'nope', 'mysql'] });
    expect(preview.problems.join('\n')).toMatch(/USE is not allowed/);
    expect(preview.problems.join('\n')).toMatch(/Unknown database\(s\): "nope"/);
    expect(preview.warnings.join('\n')).toMatch(/System database/);
    expect(preview.warnings.join('\n')).toMatch(/names database "t1" explicitly/);
    await expect(h.call({ type: 'runSqlMulti', connectionId, runId: runId(), sql: 'USE t1', databases: ['t1'], concurrency: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });

    const limited = await setup({ name: 'Limited' }, { multiRunMaxDatabases: 2 });
    await expect(
      limited.h.call({ type: 'runSqlMulti', connectionId: limited.connectionId, runId: runId(), sql: 'SELECT 1', databases: ['t1', 't2', 't3'], concurrency: 1 }),
    ).rejects.toThrow(/at most 2 databases/);
  });

  it('refuses writes on read-only connections, also on retry', async () => {
    const { h, connectionId } = await setup({ readOnly: true });
    const preview = await h.call({ type: 'previewMultiRun', connectionId, sql: 'DELETE FROM users', databases: ['t1'] });
    expect(preview.problems.join()).toMatch(/read-only/);
    await expect(h.call({ type: 'runSqlMulti', connectionId, runId: runId(), sql: 'DELETE FROM users', databases: ['t1'], concurrency: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('requires a typed confirmation on production and runs nothing when declined', async () => {
    const { h, connectionId, driver } = await setup({ environment: 'production' });
    h.setTypedConfirm(false);
    await expect(h.call({ type: 'runSqlMulti', connectionId, runId: runId(), sql: 'DELETE FROM sessions', databases: tenants, concurrency: 1 })).rejects.toMatchObject({ code: 'DECLINED' });
    expect(h.confirms).toEqual([expect.stringMatching(/PRODUCTION/), 'typed: Confirm writes on 5 production database(s) of "Local MySQL"']);
    expect(driver().calls).toEqual([]);
    h.setTypedConfirm(true);
    const id = runId();
    await h.call({ type: 'runSqlMulti', connectionId, runId: id, sql: 'DELETE FROM sessions', databases: tenants, concurrency: 1 });
    expect((await finished(h, id)).counts.succeeded).toBe(5);
  });

  it('records the run in the history', async () => {
    const { h, connectionId } = await setup();
    const id = runId();
    await h.call({ type: 'runSqlMulti', connectionId, runId: id, sql: 'SELECT 1', databases: ['t1', 't2'], concurrency: 1 });
    await finished(h, id);
    await new Promise((r) => setTimeout(r, 5));
    const history = await h.call({ type: 'listHistory', limit: 10 });
    expect(history[0]).toMatchObject({ sql: 'SELECT 1', connectionId, databaseCount: 2, status: 'ok' });
  });
});
