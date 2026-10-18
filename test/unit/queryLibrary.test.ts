import { describe, expect, it } from 'vitest';
import { finalStatus, groupErrors, newTarget, normalizeErrorMessage } from '../../src/core/services/multiRun';
import { MAX_HISTORY_SQL, QueryLibrary } from '../../src/core/services/queryLibrary';
import { qualifiedDatabaseRefs } from '../../src/core/sql/references';
import type { MultiRunTarget } from '../../src/shared/model';
import { MemoryKeyValue } from '../helpers/harness';

const clock = () => {
  let t = 1000;
  return () => ++t;
};

describe('saved queries', () => {
  it('creates, updates and persists queries with unique names', async () => {
    const kv = new MemoryKeyValue();
    const lib = new QueryLibrary(kv, clock());
    const a = await lib.save({ name: ' Active users ', tags: ['ops', ' ops ', ''], sql: 'SELECT 1', connectionId: 'c1', database: 'shop' });
    expect(a).toMatchObject({ name: 'Active users', tags: ['ops'], runCount: 0, connectionId: 'c1', database: 'shop' });
    await expect(lib.save({ name: 'ACTIVE USERS', tags: [], sql: 'SELECT 2' })).rejects.toThrow(/already exists/);
    await expect(lib.save({ name: '  ', tags: [], sql: 'SELECT 2' })).rejects.toThrow(/needs a name/);
    await expect(lib.save({ id: 'missing', name: 'x', tags: [], sql: 'SELECT 2' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const updated = await lib.save({ id: a.id, name: 'Active users', tags: [], sql: 'SELECT 2', description: '  ' });
    expect(updated).toMatchObject({ id: a.id, sql: 'SELECT 2', createdAt: a.createdAt, connectionId: undefined, description: undefined });
    expect(updated.updatedAt).toBeGreaterThan(a.updatedAt);
    await lib.save({ name: 'b query', tags: [], sql: 'SELECT 3' });
    await lib.markRun(a.id);
    await lib.markRun('unknown');

    const reloaded = new QueryLibrary(kv);
    expect(reloaded.listSaved().map((q) => [q.name, q.runCount])).toEqual([
      ['Active users', 1],
      ['b query', 0],
    ]);
    expect(await reloaded.deleteSaved(a.id)).toBe(true);
    expect(await reloaded.deleteSaved(a.id)).toBe(false);
    expect(new QueryLibrary(kv).listSaved()).toHaveLength(1);
  });

  it('ignores corrupt stored data', () => {
    const kv = new MemoryKeyValue();
    kv.map.set('deepdive.savedQueries.v1', [null, { id: 1 }, { id: 'ok', sql: 'SELECT 1', name: 'x', tags: [] }]);
    kv.map.set('deepdive.queryHistory.v1', 'garbage');
    const lib = new QueryLibrary(kv);
    expect(lib.listSaved().map((q) => q.id)).toEqual(['ok']);
    expect(lib.listHistory({ limit: 10 })).toEqual([]);
  });
});

describe('query history', () => {
  const run = (sql: string, extra: object = {}) => ({ sql, connectionId: 'c1', database: 'shop', status: 'ok' as const, durationMs: 3, ...extra });

  it('folds consecutive identical runs and keeps the newest first', async () => {
    const lib = new QueryLibrary(new MemoryKeyValue(), clock());
    await lib.record(run('SELECT 1'), 100);
    await lib.record(run('SELECT 1', { status: 'error', error: 'boom' }), 100);
    await lib.record(run('SELECT 1', { database: 'hr' }), 100);
    await lib.record(run('SELECT 2', { connectionId: 'c2' }), 100);
    const all = lib.listHistory({ limit: 10 });
    expect(all.map((h) => [h.sql, h.database, h.runs])).toEqual([
      ['SELECT 2', 'shop', 1],
      ['SELECT 1', 'hr', 1],
      ['SELECT 1', 'shop', 2],
    ]);
    expect(all[2]).toMatchObject({ status: 'error', error: 'boom' });
    expect(lib.listHistory({ limit: 10, connectionId: 'c2' })).toHaveLength(1);
    expect(lib.listHistory({ limit: 10, term: 'select 1' })).toHaveLength(2);
    expect(lib.listHistory({ limit: 1 })).toHaveLength(1);
  });

  it('caps the number of entries and skips huge scripts', async () => {
    const lib = new QueryLibrary(new MemoryKeyValue(), clock());
    for (let i = 0; i < 15; i++) await lib.record(run(`SELECT ${i}`), 10);
    expect(lib.listHistory({ limit: 100 }).map((h) => h.sql)[9]).toBe('SELECT 5');
    expect(lib.listHistory({ limit: 100 })).toHaveLength(10);
    expect(await lib.record(run('x'.repeat(MAX_HISTORY_SQL + 1)), 10)).toBeUndefined();
    const id = lib.listHistory({ limit: 1 })[0]!.id;
    expect(await lib.deleteHistoryEntry(id)).toBe(true);
    await lib.clearHistory();
    expect(lib.listHistory({ limit: 100 })).toEqual([]);
  });
});

describe('multi-database run helpers', () => {
  const target = (database: string, statuses: ('ok' | 'error' | 'not_run')[], error?: { code: string; message: string }): MultiRunTarget => {
    const t = newTarget(database, statuses.length);
    t.statements = statuses.map((status) => (status === 'error' ? { status, error: error!.message, errorCode: error!.code } : { status }));
    Object.assign(t, finalStatus(t.statements));
    return t;
  };

  it('derives the status of a database from its statements', () => {
    expect(finalStatus([{ status: 'ok' }, { status: 'ok' }])).toEqual({ status: 'succeeded' });
    expect(finalStatus([{ status: 'error' }, { status: 'not_run' }])).toEqual({ status: 'failed', failedStatementIndex: 0 });
    expect(finalStatus([{ status: 'ok' }, { status: 'error' }, { status: 'not_run' }])).toEqual({ status: 'partial', failedStatementIndex: 1 });
    expect(finalStatus([{ status: 'not_run' }])).toEqual({ status: 'not_run' });
    expect(finalStatus([{ status: 'ok' }, { status: 'not_run' }])).toEqual({ status: 'partial', failedStatementIndex: 1 });
  });

  it('groups errors that differ only by database name', () => {
    expect(normalizeErrorMessage("ER_NO_SUCH_TABLE: Table 'tenant_1.users' doesn't exist", 'ER_NO_SUCH_TABLE', 'tenant_1')).toBe("Table '<db>.users' doesn't exist");
    expect(normalizeErrorMessage('Unknown column in `tenant_10`.`users`', 'X', 'tenant_1')).toBe('Unknown column in `tenant_10`.`users`');
    const groups = groupErrors([
      target('tenant_1', ['error'], { code: 'ER_NO_SUCH_TABLE', message: "ER_NO_SUCH_TABLE: Table 'tenant_1.users' doesn't exist" }),
      target('tenant_2', ['ok', 'error'], { code: 'ER_DUP_KEYNAME', message: "ER_DUP_KEYNAME: Duplicate key name 'ia'" }),
      target('tenant_3', ['error'], { code: 'ER_NO_SUCH_TABLE', message: "ER_NO_SUCH_TABLE: Table 'tenant_3.users' doesn't exist" }),
      target('tenant_4', ['ok']),
    ]);
    expect(groups).toEqual([
      { code: 'ER_NO_SUCH_TABLE', message: "Table '<db>.users' doesn't exist", databases: ['tenant_1', 'tenant_3'] },
      { code: 'ER_DUP_KEYNAME', message: "Duplicate key name 'ia'", databases: ['tenant_2'] },
    ]);
  });

  it('finds explicit database references outside strings and comments', () => {
    const dbs = ['shop', 'Tenant_A', 'hr'];
    expect(qualifiedDatabaseRefs('SELECT * FROM shop.orders o JOIN `tenant_a` . `users` u ON o.id = u.id', dbs)).toEqual(['shop', 'Tenant_A']);
    expect(qualifiedDatabaseRefs("SELECT 'shop.orders', o.id FROM orders o -- hr.staff", dbs)).toEqual([]);
    expect(qualifiedDatabaseRefs('SELECT x.shop.y FROM t', dbs)).toEqual([]);
  });
});
