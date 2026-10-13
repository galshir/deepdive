import { describe, expect, it } from 'vitest';
import { requestSchema } from '../../src/shared/protocol';
import { createHarness } from '../helpers/harness';

describe('request schema', () => {
  it('accepts well-formed requests', () => {
    expect(requestSchema.safeParse({ type: 'listTables', connectionId: 'c1', database: 'shop' }).success).toBe(true);
    expect(
      requestSchema.safeParse({
        type: 'fetchTableRows',
        connectionId: 'c1',
        queryId: 'q1',
        query: { database: 'shop', table: 'orders', limit: 100, offset: 0, filter: { kind: 'group', id: 'r', combinator: 'or', children: [] } },
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ type: 'dropEverything' }],
    [{ type: 'listTables', connectionId: 'c1' }],
    [{ type: 'listTables', connectionId: 'c1', database: '' }],
    [{ type: 'listTables', connectionId: 'c1', database: 'x'.repeat(65) }],
    [{ type: 'listTables', connectionId: 1, database: 'shop' }],
    [{ type: 'fetchTableRows', connectionId: 'c', queryId: 'q', query: { database: 'a', table: 'b', limit: 1e9, offset: 0 } }],
    [{ type: 'fetchTableRows', connectionId: 'c', queryId: 'q', query: { database: 'a', table: 'b', limit: 10, offset: -5 } }],
    [{ type: 'fetchTableRows', connectionId: 'c', queryId: 'q', query: { database: 'a', table: 'b', limit: 10, offset: 0, sort: [{ column: 'x', direction: 'up' }] } }],
    [{ type: 'buildQuery', connectionId: 'c', model: { tables: [{ alias: 'a b', database: 'x', table: 'y' }], joins: [], columns: [], filter: { kind: 'group', id: 'r', combinator: 'and', children: [] }, groupBy: [], orderBy: [], limit: 1, distinct: false } }],
    [{ type: 'saveConnection', config: { name: '', color: 'red' } }],
    [{ type: 'searchData', request: { searchId: 's', connectionId: 'c', database: 'd', tables: [], term: 'x', match: 'contains', perTableLimit: 10 } }],
    [{ type: 'fetchTableRows', connectionId: 'c', queryId: 'q', query: { database: 'a', table: 'b', limit: 10, offset: 0, filter: { kind: 'group', id: 'r', combinator: 'xor', children: [] } } }],
  ])('rejects malformed request %#', (payload) => {
    expect(requestSchema.safeParse(payload).success).toBe(false);
  });
});

describe('router message handling', () => {
  it('ignores malformed envelopes and reports invalid payloads without throwing', async () => {
    const h = await createHarness();
    expect(await h.router.handle('hello')).toBeNull();
    expect(await h.router.handle({ kind: 'request', id: -1, payload: {} })).toBeNull();
    const res = await h.raw({ type: 'nope' });
    expect(res).toMatchObject({ kind: 'response', ok: false, error: { code: 'VALIDATION' } });
  });

  it('answers with the request id', async () => {
    const h = await createHarness();
    const res = await h.router.handle({ kind: 'request', id: 42, payload: { type: 'listConnections' } });
    expect(res).toEqual({ kind: 'response', id: 42, ok: true, result: [] });
  });

  it('returns NOT_CONNECTED/NOT_FOUND errors instead of crashing', async () => {
    const h = await createHarness();
    const r1 = await h.raw({ type: 'listDatabases', connectionId: 'ghost' });
    expect(r1).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
    const r2 = await h.raw({ type: 'connect', connectionId: 'ghost' });
    expect(r2).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
