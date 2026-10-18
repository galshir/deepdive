import { describe, expect, it } from 'vitest';
import type { DbDriver, QueryOptions } from '../../src/core/drivers/driver';
import { DeepDiveError } from '../../src/core/errors';
import type { ConnectionConfig, QueryResult } from '../../src/shared/model';
import { createHarness, mysqlInput } from '../helpers/harness';

/** A controllable driver used to simulate slow servers, failures and disconnects. */
class FakeDriver implements DbDriver {
  readonly dialect = 'mysql' as const;
  static instances: FakeDriver[] = [];
  closed = false;
  connectDelay = 0;
  queryDelay = 0;
  constructor(
    readonly config: ConnectionConfig,
    readonly password: string | undefined,
    private readonly failWith?: unknown,
  ) {
    FakeDriver.instances.push(this);
  }
  async connect() {
    await new Promise((r) => setTimeout(r, this.connectDelay));
    if (this.failWith) throw this.failWith;
    return '8.0.36-fake';
  }
  async close() {
    this.closed = true;
  }
  async listDatabases() {
    return [{ name: 'app', isSystem: false, tableCount: 1 }];
  }
  async listTables() {
    return [{ database: 'app', name: 't', type: 'table' as const }];
  }
  async loadTableDetails(): Promise<never> {
    throw new DeepDiveError('nope', 'NOT_FOUND');
  }
  async loadDatabaseSchema() {
    return { database: 'app', tables: [], columns: [], indexes: [], foreignKeys: [] };
  }
  async searchMetadata() {
    return [];
  }
  async locateTable() {
    return [];
  }
  query(_sql: string, _p: unknown, options: QueryOptions): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const done = setTimeout(() => resolve({ kind: 'rows', columns: [{ name: 'x' }], rows: [[1]], truncated: false, durationMs: this.queryDelay }), this.queryDelay);
      const timer = setTimeout(() => {
        clearTimeout(done);
        reject(new DeepDiveError('Query exceeded the timeout and was cancelled', 'TIMEOUT'));
      }, options.timeoutMs);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(done);
        clearTimeout(timer);
        reject(new DeepDiveError('Query cancelled', 'CANCELLED'));
      });
      if (this.queryDelay < options.timeoutMs) setTimeout(() => clearTimeout(timer), this.queryDelay);
    });
  }
  async transaction() {
    return [];
  }
}

const fakeFactory = (opts: { fail?: unknown; queryDelay?: number; connectDelay?: number } = {}) => (config: ConnectionConfig, pw: string | undefined) => {
  const d = new FakeDriver(config, pw, opts.fail);
  d.queryDelay = opts.queryDelay ?? 0;
  d.connectDelay = opts.connectDelay ?? 0;
  return d;
};

describe('connection management', () => {
  it('stores passwords only in secret storage and never returns them', async () => {
    const h = await createHarness({ factory: fakeFactory() });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput(), password: 'hunter2-secret' });
    expect(s.hasPassword).toBe(true);
    expect(JSON.stringify(h.store.configs)).not.toContain('hunter2');
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect([...h.secrets.map.values()]).toEqual(['hunter2-secret']);
    // Saving without a password keeps the stored one; null clears it.
    await h.call({ type: 'saveConnection', config: { ...mysqlInput(), id: s.config.id, name: 'Renamed' } });
    expect(h.secrets.map.size).toBe(1);
    await h.call({ type: 'connect', connectionId: s.config.id });
    expect(FakeDriver.instances.at(-1)!.password).toBe('hunter2-secret');
    await h.call({ type: 'saveConnection', config: { ...mysqlInput(), id: s.config.id, name: 'Renamed' }, password: null });
    expect(h.secrets.map.size).toBe(0);
    // Removing deletes the secret and config.
    await h.call({ type: 'deleteConnection', connectionId: s.config.id });
    expect(h.store.configs).toEqual([]);
  });

  it('rejects duplicate names and invalid settings', async () => {
    const h = await createHarness({ factory: fakeFactory() });
    await h.call({ type: 'saveConnection', config: mysqlInput() });
    await expect(h.call({ type: 'saveConnection', config: mysqlInput({ name: 'local mysql' }) })).rejects.toThrow(/already exists/);
    await expect(h.call({ type: 'saveConnection', config: mysqlInput({ name: 'x', host: '' }) })).rejects.toThrow(/Host/);
    await expect(h.call({ type: 'saveConnection', config: mysqlInput({ name: 'y', port: 70000 }) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(h.call({ type: 'saveConnection', config: mysqlInput({ name: 'z', tls: { mode: 'disabled', caPath: '/ca.pem' } }) })).rejects.toThrow(/TLS/);
  });

  it('redacts the password from connection errors', async () => {
    const h = await createHarness({ factory: fakeFactory({ fail: new Error("Access denied for 'root' using password=s3cr3t-pw (s3cr3t-pw)") }) });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput(), password: 's3cr3t-pw' });
    const err = await h.call({ type: 'connect', connectionId: s.config.id }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('s3cr3t-pw');
    const summary = (await h.call({ type: 'listConnections' }))[0]!;
    expect(summary.status).toBe('error');
    expect(summary.error).not.toContain('s3cr3t-pw');
  });

  it('enforces the maximum number of open connections', async () => {
    const h = await createHarness({ factory: fakeFactory(), settings: { maxActiveConnections: 2 } });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) ids.push((await h.call({ type: 'saveConnection', config: mysqlInput({ name }) })).config.id);
    await h.call({ type: 'connect', connectionId: ids[0]! });
    await h.call({ type: 'connect', connectionId: ids[1]! });
    await expect(h.call({ type: 'connect', connectionId: ids[2]! })).rejects.toMatchObject({ code: 'LIMIT' });
    await h.call({ type: 'disconnect', connectionId: ids[0]! });
    await h.call({ type: 'connect', connectionId: ids[2]! });
  });

  it('coalesces concurrent connect calls into one session', async () => {
    FakeDriver.instances = [];
    const h = await createHarness({ factory: fakeFactory({ connectDelay: 30 }) });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput() });
    await Promise.all([h.call({ type: 'connect', connectionId: s.config.id }), h.call({ type: 'connect', connectionId: s.config.id })]);
    expect(FakeDriver.instances).toHaveLength(1);
  });

  it('closes drivers on disconnect and on disconnectAll', async () => {
    FakeDriver.instances = [];
    const h = await createHarness({ factory: fakeFactory() });
    const a = await h.call({ type: 'saveConnection', config: mysqlInput({ name: 'a' }) });
    const b = await h.call({ type: 'saveConnection', config: mysqlInput({ name: 'b' }) });
    await h.call({ type: 'connect', connectionId: a.config.id });
    await h.call({ type: 'connect', connectionId: b.config.id });
    await h.manager.disconnectAll();
    expect(FakeDriver.instances.every((d) => d.closed)).toBe(true);
    expect((await h.call({ type: 'listConnections' })).every((c) => c.status === 'disconnected')).toBe(true);
  });

  it('times out slow queries', async () => {
    const h = await createHarness({ factory: fakeFactory({ queryDelay: 500 }), settings: { queryTimeoutMs: 50 } });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput() });
    await h.call({ type: 'connect', connectionId: s.config.id });
    const res = await h.call({ type: 'runSql', connectionId: s.config.id, queryId: 'slow', sql: 'SELECT SLEEP(10)' });
    expect(res.statements[0]!.error).toMatch(/timeout/);
  });

  it('cancels running queries on request and on disconnect', async () => {
    const h = await createHarness({ factory: fakeFactory({ queryDelay: 5000 }) });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput() });
    await h.call({ type: 'connect', connectionId: s.config.id });
    const running = h.call({ type: 'runSql', connectionId: s.config.id, queryId: 'long', sql: 'SELECT 1; SELECT 2' });
    await new Promise((r) => setTimeout(r, 20));
    expect(await h.call({ type: 'cancelQuery', queryId: 'long' })).toBe(true);
    const res = await running;
    expect(res.cancelled).toBe(true);
    expect(res.statements).toHaveLength(1);
    expect(await h.call({ type: 'cancelQuery', queryId: 'long' })).toBe(false);

    const second = h.call({ type: 'runSql', connectionId: s.config.id, queryId: 'long2', sql: 'SELECT 1' });
    await new Promise((r) => setTimeout(r, 20));
    await h.call({ type: 'disconnect', connectionId: s.config.id });
    expect((await second).cancelled).toBe(true);
  });

  it('switches between connections without mixing metadata caches', async () => {
    const h = await createHarness();
    const [acme, lake] = await h.call({ type: 'addDemoConnections' });
    await h.call({ type: 'connect', connectionId: acme!.config.id });
    await h.call({ type: 'connect', connectionId: lake!.config.id });
    const a = await h.call({ type: 'listTables', connectionId: acme!.config.id, database: 'shop' });
    await expect(h.call({ type: 'listTables', connectionId: lake!.config.id, database: 'shop' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const again = await h.call({ type: 'listTables', connectionId: acme!.config.id, database: 'shop' });
    expect(again).toEqual(a);
    // Refresh invalidates only the requested connection.
    const sizeBefore = h.metadata.size();
    await h.call({ type: 'listDatabases', connectionId: lake!.config.id, refresh: true });
    expect(h.metadata.size()).toBeLessThanOrEqual(sizeBefore + 1);
    await h.call({ type: 'listTables', connectionId: acme!.config.id, database: 'shop' });
  });
});
