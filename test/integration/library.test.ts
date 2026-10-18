import { beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '../../src/shared/model';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let acme: ConnectionSummary;

beforeAll(async () => {
  h = await createHarness();
  acme = (await h.call({ type: 'addDemoConnections' }))[0]!;
  await h.call({ type: 'connect', connectionId: acme.config.id });
});

describe('saved queries and history through the router', () => {
  it('records SQL editor runs with their outcome', async () => {
    const connectionId = acme.config.id;
    await h.call({ type: 'runSql', connectionId, queryId: 'h1', sql: 'SELECT COUNT(*) FROM customers', database: 'shop' });
    await h.call({ type: 'runSql', connectionId, queryId: 'h2', sql: 'SELECT * FROM no_such_table', database: 'shop' });
    const history = await h.call({ type: 'listHistory', limit: 10 });
    expect(history[0]).toMatchObject({ sql: 'SELECT * FROM no_such_table', status: 'error', database: 'shop', connectionId });
    expect(history[0]!.error).toMatch(/no such table/);
    expect(history[1]).toMatchObject({ sql: 'SELECT COUNT(*) FROM customers', status: 'ok', rowCount: 1 });
    expect(h.events.some((e) => e.type === 'historyChanged')).toBe(true);

    h.settings.historyEnabled = false;
    await h.call({ type: 'runSql', connectionId, queryId: 'h3', sql: 'SELECT 42', database: 'shop' });
    expect((await h.call({ type: 'listHistory', limit: 10 }))[0]!.sql).not.toBe('SELECT 42');
    h.settings.historyEnabled = true;
  });

  it('reports server error codes on failed statements', async () => {
    const res = await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 'e1', sql: 'SELECT * FROM nope', database: 'shop' });
    expect(res.statements[0]).toMatchObject({ errorCode: 'DB_ERROR' });
  });

  it('saves, lists, tracks runs and deletes saved queries', async () => {
    const saved = await h.call({ type: 'saveQuery', query: { name: 'VIP customers', tags: ['crm'], sql: 'SELECT * FROM customers WHERE is_vip = 1', connectionId: acme.config.id, database: 'shop' } });
    expect((await h.call({ type: 'init' })).savedQueries.map((q) => q.name)).toContain('VIP customers');
    expect(h.events.at(-2)).toMatchObject({ type: 'savedQueriesChanged' });

    await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's1', sql: saved.sql, database: 'shop', savedQueryId: saved.id });
    expect((await h.call({ type: 'listSavedQueries' })).find((q) => q.id === saved.id)!.runCount).toBe(1);

    h.setConfirm(false);
    expect(await h.call({ type: 'deleteSavedQuery', id: saved.id })).toBe(false);
    h.setConfirm(true);
    expect(await h.call({ type: 'deleteSavedQuery', id: saved.id })).toBe(true);
    expect(await h.call({ type: 'listSavedQueries' })).toEqual([]);
    expect(h.confirms.at(-1)).toBe('Delete saved query "VIP customers"?');
  });

  it('clears the history only after confirmation', async () => {
    h.setConfirm(false);
    expect(await h.call({ type: 'clearHistory' })).toBe(false);
    expect((await h.call({ type: 'listHistory', limit: 10 })).length).toBeGreaterThan(0);
    h.setConfirm(true);
    expect(await h.call({ type: 'clearHistory' })).toBe(true);
    expect(await h.call({ type: 'listHistory', limit: 10 })).toEqual([]);
  });

  it('locates tables and columns across demo databases', async () => {
    const connectionId = acme.config.id;
    expect(await h.call({ type: 'locateTable', connectionId, table: 'customers' })).toEqual([{ database: 'shop' }]);
    expect(await h.call({ type: 'locateTable', connectionId, table: 'customers', column: 'email' })).toEqual([{ database: 'shop', hasColumn: true }]);
    expect(await h.call({ type: 'locateTable', connectionId, table: 'customers', column: 'nope' })).toEqual([{ database: 'shop', hasColumn: false }]);
    expect(await h.call({ type: 'locateTable', connectionId, table: 'nope' })).toEqual([]);
  });

  it('validates saved query input', async () => {
    await expect(h.call({ type: 'saveQuery', query: { name: '', tags: [], sql: 'SELECT 1' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(h.call({ type: 'saveQuery', query: { name: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`), sql: 'SELECT 1' } })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
