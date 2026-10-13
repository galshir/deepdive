import { beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionSummary, DataSearchProgress, QueryModel } from '../../src/shared/model';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let acme: ConnectionSummary;
let lake: ConnectionSummary;

beforeAll(async () => {
  h = await createHarness({ settings: { maxTablesPerDataSearch: 20 } });
  const demos = await h.call({ type: 'addDemoConnections' });
  acme = demos[0]!;
  lake = demos[1]!;
  await h.call({ type: 'connect', connectionId: acme.config.id });
  await h.call({ type: 'connect', connectionId: lake.config.id });
});

const filterActive = { kind: 'group' as const, id: 'r', combinator: 'and' as const, children: [{ kind: 'condition' as const, id: 'c', column: 'status', operator: 'eq' as const, value: 'active' }] };

describe('demo connections', () => {
  it('creates two independent demo connections only once', async () => {
    const again = await h.call({ type: 'addDemoConnections' });
    expect(again.map((c) => c.config.id)).toEqual([acme.config.id, lake.config.id]);
    const list = await h.call({ type: 'listConnections' });
    expect(list.filter((c) => c.status === 'connected')).toHaveLength(2);
    expect(h.events.some((e) => e.type === 'connectionsChanged')).toBe(true);
  });

  it('discovers databases per connection, including an empty schema', async () => {
    const a = await h.call({ type: 'listDatabases', connectionId: acme.config.id });
    expect(a.map((d) => d.name)).toEqual(['shop', 'analytics', 'hr', 'sandbox']);
    expect(a.find((d) => d.name === 'sandbox')!.tableCount).toBe(0);
    const tables = await h.call({ type: 'listTables', connectionId: acme.config.id, database: 'sandbox' });
    expect(tables).toEqual([]);
    const l = await h.call({ type: 'listDatabases', connectionId: lake.config.id });
    expect(l.map((d) => d.name)).toEqual(['warehouse', 'staging', 'archive']);
  });

  it('reads primary keys, foreign keys and cardinality', async () => {
    const orders = await h.call({ type: 'getTableDetails', connectionId: acme.config.id, database: 'shop', table: 'orders' });
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.foreignKeys).toHaveLength(1);
    expect(orders.foreignKeys[0]).toMatchObject({ table: 'orders', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'], cardinality: 'many-to-one' });
    expect(orders.referencedBy.map((f) => f.table).sort()).toEqual(['order_items', 'payments']);
    expect(orders.referencedBy.find((f) => f.table === 'payments')!.cardinality).toBe('one-to-one');
    const items = await h.call({ type: 'getTableDetails', connectionId: acme.config.id, database: 'shop', table: 'order_items' });
    expect(items.primaryKey).toEqual(['order_id', 'product_id']);
    const email = (await h.call({ type: 'getTableDetails', connectionId: acme.config.id, database: 'shop', table: 'customers' })).columns.find((c) => c.name === 'email')!;
    expect(email).toMatchObject({ nullable: false, key: 'UNI', dataType: 'varchar', columnType: 'varchar(255)' });
  });

  it('does not invent relationships where no foreign keys exist', async () => {
    const schema = await h.call({ type: 'getDatabaseSchema', connectionId: acme.config.id, database: 'analytics' });
    expect(schema.tables.length).toBe(4);
    expect(schema.foreignKeys).toEqual([]);
  });

  it('handles a large schema (1200+ tables)', async () => {
    const tables = await h.call({ type: 'listTables', connectionId: lake.config.id, database: 'warehouse' });
    expect(tables.length).toBe(1201);
    const schema = await h.call({ type: 'getDatabaseSchema', connectionId: lake.config.id, database: 'warehouse' });
    expect(schema.columns.length).toBe(1201 * 5 - 2);
    expect(schema.foreignKeys.length).toBe(120);
  });

  it('browses rows with filters, sorting and pagination', async () => {
    const page = await h.call({
      type: 'fetchTableRows',
      connectionId: acme.config.id,
      queryId: 'q1',
      query: { database: 'shop', table: 'customers', columns: ['email', 'status'], filter: filterActive, sort: [{ column: 'email', direction: 'asc' }], limit: 25, offset: 0 },
    });
    expect(page.rows).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    expect(page.hiddenColumns).toEqual(['id']);
    expect(page.rows.every((r) => r[1] === 'active')).toBe(true);
    const emails = page.rows.map((r) => String(r[0]));
    expect([...emails].sort()).toEqual(emails);
    expect(page.displaySql).toContain("WHERE `status` = 'active'");
    const count = await h.call({ type: 'countRows', connectionId: acme.config.id, queryId: 'q2', database: 'shop', table: 'customers', filter: filterActive });
    expect(count.count).toBeGreaterThan(25);
    const last = await h.call({
      type: 'fetchTableRows',
      connectionId: acme.config.id,
      queryId: 'q3',
      query: { database: 'shop', table: 'customers', filter: filterActive, limit: 25, offset: count.count - 5 },
    });
    expect(last.rows).toHaveLength(5);
    expect(last.hasMore).toBe(false);
  });

  it('builds and runs visual queries with joins and aggregates', async () => {
    const model: QueryModel = {
      tables: [
        { alias: 'c', database: 'shop', table: 'customers' },
        { alias: 'o', database: 'shop', table: 'orders' },
      ],
      joins: [{ id: 'j1', type: 'inner', leftAlias: 'o', leftColumn: 'customer_id', rightAlias: 'c', rightColumn: 'id' }],
      columns: [
        { id: '1', source: 'c', column: 'country' },
        { id: '2', source: 'o', column: 'id', aggregate: 'count', as: 'orders' },
      ],
      filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'x', source: 'o', column: 'status', operator: 'in', values: ['paid', 'shipped'] }] },
      groupBy: [],
      orderBy: [{ source: 'c', column: 'country', direction: 'asc' }],
      limit: 50,
      distinct: false,
    };
    const preview = await h.call({ type: 'buildQuery', connectionId: acme.config.id, model });
    expect(preview.displaySql).toContain("IN ('paid', 'shipped')");
    const run = await h.call({ type: 'runQueryModel', connectionId: acme.config.id, queryId: 'qb', model });
    expect(run.statement.error).toBeUndefined();
    expect(run.statement.result!.columns.map((c) => c.name)).toEqual(['country', 'orders']);
    expect(run.statement.result!.rows.length).toBe(10);
  });

  it('runs read-only SQL without confirmation and honours row limits', async () => {
    h.confirms.length = 0;
    const res = await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's1', sql: 'SELECT * FROM page_views; SELECT 1 AS one' });
    expect(h.confirms).toEqual([]);
    expect(res.statements).toHaveLength(2);
    expect(res.statements[0]!.result!.rows).toHaveLength(h.settings.maxResultRows);
    expect(res.statements[0]!.result!.truncated).toBe(true);
    expect(res.statements[1]!.result!.rows).toEqual([[1]]);
  });

  it('requires explicit confirmation for writes and does nothing when declined', async () => {
    h.setConfirm(false);
    const before = await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's2', sql: "SELECT status FROM shop.customers WHERE id = 1" });
    await expect(h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's3', sql: "UPDATE shop.customers SET status = 'x' WHERE id = 1" })).rejects.toMatchObject({ code: 'DECLINED' });
    const after = await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's4', sql: 'SELECT status FROM shop.customers WHERE id = 1' });
    expect(after.statements[0]!.result!.rows).toEqual(before.statements[0]!.result!.rows);
    h.setConfirm(true);
    const ok = await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's5', sql: "UPDATE shop.customers SET status = 'vip' WHERE id = 1" });
    expect(ok.statements[0]!.result).toMatchObject({ kind: 'ok', affectedRows: 1 });
  });

  it('applies grid edits in a verified transaction', async () => {
    h.setConfirm(true);
    const res = await h.call({
      type: 'applyEdits',
      connectionId: acme.config.id,
      database: 'shop',
      table: 'customers',
      updates: [{ key: { id: 2 }, changes: { status: 'inactive', is_vip: true } }],
      deletes: [],
    });
    expect(res).toMatchObject({ committed: true, statements: 1, affectedRows: 1 });
    // A missing row rolls back the whole batch.
    await expect(
      h.call({
        type: 'applyEdits',
        connectionId: acme.config.id,
        database: 'shop',
        table: 'customers',
        updates: [{ key: { id: 3 }, changes: { status: 'changed' } }, { key: { id: 999999 }, changes: { status: 'ghost' } }],
        deletes: [],
      }),
    ).rejects.toThrow(/rolled back/);
    const check = await h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 's6', sql: 'SELECT status FROM shop.customers WHERE id = 3' });
    expect(check.statements[0]!.result!.rows[0]![0]).not.toBe('changed');
  });

  it('refuses writes on read-only connections', async () => {
    const ro = await h.call({ type: 'saveConnection', config: { ...acme.config, readOnly: true } });
    await h.call({ type: 'connect', connectionId: ro.config.id });
    await expect(h.call({ type: 'runSql', connectionId: acme.config.id, queryId: 'w', sql: 'DELETE FROM shop.reviews' })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(
      h.call({ type: 'applyEdits', connectionId: acme.config.id, database: 'shop', table: 'customers', updates: [{ key: { id: 1 }, changes: { status: 'a' } }], deletes: [] }),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    await h.call({ type: 'saveConnection', config: { ...acme.config, readOnly: false } });
    await h.call({ type: 'connect', connectionId: acme.config.id });
  });

  it('searches metadata across connections', async () => {
    const res = await h.call({ type: 'searchMetadata', term: 'customer', limit: 50 });
    const tables = res.hits.filter((x) => x.kind === 'table').map((x) => `${x.database}.${x.table}`);
    expect(tables).toEqual(expect.arrayContaining(['shop.customers', 'shop.customer_profiles']));
    expect(res.hits.some((x) => x.kind === 'column' && x.column === 'customer_id' && x.table === 'sessions')).toBe(true);
    const scoped = await h.call({ type: 'searchMetadata', term: 'store', connectionIds: [lake.config.id], limit: 5 });
    expect(scoped.hits.every((x) => x.connectionId === lake.config.id)).toBe(true);
    expect(scoped.limited).toBe(true);
  });

  it('searches data within an explicit scope and reports progress', async () => {
    h.events.length = 0;
    await h.call({ type: 'searchData', request: { searchId: 'ds1', connectionId: acme.config.id, database: 'shop', tables: ['customers', 'products', 'orders'], term: 'gift wrap', match: 'contains', perTableLimit: 5 } });
    await waitFor(() => progress('ds1').some((p) => p.finished));
    const results = progress('ds1').filter((p) => p.result).map((p) => p.result!);
    expect(results.map((r) => r.table)).toEqual(['customers', 'products', 'orders']);
    expect(results.find((r) => r.table === 'orders')!.rows.length).toBe(5);
    expect(results.find((r) => r.table === 'orders')!.limited).toBe(true);
    await expect(
      h.call({ type: 'searchData', request: { searchId: 'ds2', connectionId: acme.config.id, database: 'shop', tables: Array.from({ length: 21 }, (_, i) => `t${i}`), term: 'x', match: 'contains', perTableLimit: 5 } }),
    ).rejects.toThrow(/at most 20/);
  });

  it('cancels a data search', async () => {
    h.events.length = 0;
    const tables = (await h.call({ type: 'listTables', connectionId: lake.config.id, database: 'warehouse' })).slice(0, 20).map((t) => t.name);
    await h.call({ type: 'searchData', request: { searchId: 'ds3', connectionId: lake.config.id, database: 'warehouse', tables, term: 'batch', match: 'contains', perTableLimit: 5 } });
    expect(await h.call({ type: 'cancelSearch', searchId: 'ds3' })).toBe(true);
    await waitFor(() => progress('ds3').some((p) => p.finished));
    expect(progress('ds3').find((p) => p.finished)!.cancelled).toBe(true);
  });

  it('keeps connections independent when one disconnects', async () => {
    await h.call({ type: 'disconnect', connectionId: lake.config.id });
    await expect(h.call({ type: 'listDatabases', connectionId: lake.config.id })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect((await h.call({ type: 'listDatabases', connectionId: acme.config.id })).length).toBe(4);
    await h.call({ type: 'connect', connectionId: lake.config.id });
    expect((await h.call({ type: 'listDatabases', connectionId: lake.config.id })).length).toBe(3);
  });

  it('validates identifiers against metadata, not just syntax', async () => {
    await expect(h.call({ type: 'getTableDetails', connectionId: acme.config.id, database: 'shop', table: 'customers`; DROP TABLE x; --' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      h.call({ type: 'fetchTableRows', connectionId: acme.config.id, queryId: 'bad', query: { database: 'shop', table: 'customers', columns: ['email` FROM x; --'], limit: 5, offset: 0 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

function progress(id: string): DataSearchProgress[] {
  return h.events.flatMap((e) => (e.type === 'searchProgress' && e.progress.searchId === id ? [e.progress] : []));
}

async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
