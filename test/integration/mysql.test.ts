// Integration tests against a real MySQL server. Skipped unless DEEPDIVE_MYSQL_TEST=1.
//   docker run -d --rm --name deepdive-mysql-test -e MYSQL_ROOT_PASSWORD=deepdive-root-pw -p 127.0.0.1:33061:3306 mysql:8.4
//   DEEPDIVE_MYSQL_TEST=1 npm run test:mysql
import * as mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MysqlDriver } from '../../src/core/drivers/mysqlDriver';
import type { ConnectionConfig, TableLocation } from '../../src/shared/model';
import { createHarness, type Harness, mysqlInput } from '../helpers/harness';

const enabled = process.env.DEEPDIVE_MYSQL_TEST === '1';
const host = process.env.DEEPDIVE_MYSQL_HOST ?? '127.0.0.1';
const port = Number(process.env.DEEPDIVE_MYSQL_PORT ?? 33061);
const user = process.env.DEEPDIVE_MYSQL_USER ?? 'root';
const password = process.env.DEEPDIVE_MYSQL_PASSWORD ?? 'deepdive-root-pw';

const config = (patch: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'it',
  name: 'it',
  color: '#000000',
  kind: 'mysql',
  environment: 'development',
  host,
  port,
  user,
  readOnly: false,
  tls: { mode: 'disabled' },
  connectTimeoutMs: 5000,
  ...patch,
});

const opts = { timeoutMs: 10_000, maxRows: 1000 };

describe.skipIf(!enabled)('real MySQL', () => {
  let admin: mysql.Connection;
  let driver: MysqlDriver;

  beforeAll(async () => {
    admin = await mysql.createConnection({ host, port, user, password, multipleStatements: true });
    await admin.query(`
      DROP DATABASE IF EXISTS dd_shop; DROP DATABASE IF EXISTS dd_nofk; DROP DATABASE IF EXISTS dd_empty;
      CREATE DATABASE dd_shop; CREATE DATABASE dd_nofk; CREATE DATABASE dd_empty;
      CREATE TABLE dd_shop.customers (id INT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(100) NOT NULL UNIQUE, status VARCHAR(16) NOT NULL DEFAULT 'active', note TEXT NULL COMMENT 'free text') COMMENT='people who buy';
      CREATE TABLE dd_shop.orders (id INT PRIMARY KEY AUTO_INCREMENT, customer_id INT NOT NULL, total DECIMAL(10,2) NOT NULL, placed_at DATETIME NOT NULL,
        CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES dd_shop.customers(id) ON DELETE CASCADE);
      CREATE TABLE dd_shop.invoices (id INT PRIMARY KEY, order_id INT NOT NULL UNIQUE, CONSTRAINT fk_invoice_order FOREIGN KEY (order_id) REFERENCES dd_shop.orders(id));
      CREATE TABLE dd_shop.order_lines (order_id INT NOT NULL, line_no INT NOT NULL, sku VARCHAR(20), PRIMARY KEY (order_id, line_no), FOREIGN KEY (order_id) REFERENCES dd_shop.orders(id));
      CREATE VIEW dd_shop.active_customers AS SELECT id, email FROM dd_shop.customers WHERE status = 'active';
      CREATE TABLE dd_nofk.events (id INT PRIMARY KEY, customer_id INT, kind VARCHAR(20));
      CREATE TABLE dd_nofk.\`odd\`\`name\` (\`we\`\`ird col\` INT);
      DROP DATABASE IF EXISTS dd_t1; DROP DATABASE IF EXISTS dd_t2; DROP DATABASE IF EXISTS dd_t3;
      CREATE DATABASE dd_t1; CREATE DATABASE dd_t2; CREATE DATABASE dd_t3;
      CREATE TABLE dd_t1.users (id INT PRIMARY KEY, name VARCHAR(20));
      CREATE TABLE dd_t2.users (id INT PRIMARY KEY, name VARCHAR(20), is_active TINYINT);
      INSERT INTO dd_t1.users VALUES (1, 'a'), (2, 'b'); INSERT INTO dd_t2.users VALUES (1, 'c', 0);
    `);
    const rows = Array.from({ length: 120 }, (_, i) => `('user${i}@x.io', '${i % 3 === 0 ? 'inactive' : 'active'}', ${i === 5 ? "'50% off_deal'" : 'NULL'})`).join(',');
    await admin.query(`INSERT INTO dd_shop.customers (email, status, note) VALUES ${rows}`);
    await admin.query(`INSERT INTO dd_shop.orders (customer_id, total, placed_at) SELECT id, id * 1.5, '2024-01-01 10:00:00' FROM dd_shop.customers`);
    driver = new MysqlDriver(config(), password, { poolSize: 3 });
    expect(await driver.connect()).toMatch(/^\d+\.\d+/);
  });

  afterAll(async () => {
    await driver?.close();
    await admin?.query(
      'DROP DATABASE IF EXISTS dd_shop; DROP DATABASE IF EXISTS dd_nofk; DROP DATABASE IF EXISTS dd_empty; DROP DATABASE IF EXISTS dd_t1; DROP DATABASE IF EXISTS dd_t2; DROP DATABASE IF EXISTS dd_t3;',
    );
    await admin?.end();
  });

  it('discovers databases (with system flags) and tables/views', async () => {
    const dbs = await driver.listDatabases();
    expect(dbs.find((d) => d.name === 'dd_shop')).toMatchObject({ tableCount: 5, isSystem: false });
    expect(dbs.find((d) => d.name === 'mysql')?.isSystem).toBe(true);
    expect(dbs.find((d) => d.name === 'dd_empty')?.tableCount).toBe(0);
    const tables = await driver.listTables('dd_shop');
    expect(tables.map((t) => `${t.name}:${t.type}`)).toEqual(['active_customers:view', 'customers:table', 'invoices:table', 'order_lines:table', 'orders:table']);
    expect(tables.find((t) => t.name === 'customers')?.comment).toBe('people who buy');
    expect(await driver.listTables('dd_empty')).toEqual([]);
  });

  it('reads keys, foreign keys and cardinality', async () => {
    const orders = await driver.loadTableDetails('dd_shop', 'orders');
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.columns.find((c) => c.name === 'id')).toMatchObject({ isAutoIncrement: true, key: 'PRI', nullable: false });
    expect(orders.foreignKeys).toEqual([
      expect.objectContaining({ name: 'fk_orders_customer', columns: ['customer_id'], referencedTable: 'customers', referencedColumns: ['id'], onDelete: 'CASCADE', cardinality: 'many-to-one' }),
    ]);
    const byTable = Object.fromEntries(orders.referencedBy.map((f) => [f.table, f.cardinality]));
    expect(byTable).toEqual({ invoices: 'one-to-one', order_lines: 'many-to-one' });
    const lines = await driver.loadTableDetails('dd_shop', 'order_lines');
    expect(lines.primaryKey).toEqual(['order_id', 'line_no']);
    const customers = await driver.loadTableDetails('dd_shop', 'customers');
    expect(customers.columns.find((c) => c.name === 'note')).toMatchObject({ comment: 'free text', nullable: true, dataType: 'text' });
    expect(customers.columns.find((c) => c.name === 'status')?.defaultValue).toBe('active');
    await expect(driver.loadTableDetails('dd_shop', 'ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not invent relationships and handles odd identifiers', async () => {
    const schema = await driver.loadDatabaseSchema('dd_nofk');
    expect(schema.foreignKeys).toEqual([]);
    const odd = await driver.loadTableDetails('dd_nofk', 'odd`name');
    expect(odd.columns[0]!.name).toBe('we`ird col');
  });

  it('browses, filters and searches end-to-end through the router', async () => {
    const h: Harness = await createHarness({ mysql: (c, pw) => new MysqlDriver(c, pw, { poolSize: 2 }) });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput({ host, port, user, readOnly: false }), password });
    await h.call({ type: 'connect', connectionId: s.config.id });
    const id = s.config.id;
    const page = await h.call({
      type: 'fetchTableRows',
      connectionId: id,
      queryId: 'p1',
      query: { database: 'dd_shop', table: 'customers', columns: ['email'], filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'status', operator: 'eq', value: 'active' }] }, sort: [{ column: 'email', direction: 'desc' }], limit: 30, offset: 0 },
    });
    expect(page.rows).toHaveLength(30);
    expect(page.hasMore).toBe(true);
    expect(page.hiddenColumns).toEqual(['id']);
    const count = await h.call({ type: 'countRows', connectionId: id, queryId: 'c1', database: 'dd_shop', table: 'customers', filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'status', operator: 'eq', value: 'active' }] } });
    expect(count.count).toBe(80);
    // LIKE wildcards in user input are matched literally.
    const like = await h.call({ type: 'fetchTableRows', connectionId: id, queryId: 'p2', query: { database: 'dd_shop', table: 'customers', filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'note', operator: 'contains', value: '0% off_' }] }, limit: 10, offset: 0 } });
    expect(like.rows).toHaveLength(1);
    const like2 = await h.call({ type: 'fetchTableRows', connectionId: id, queryId: 'p3', query: { database: 'dd_shop', table: 'customers', filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'note', operator: 'contains', value: '5_%' }] }, limit: 10, offset: 0 } });
    expect(like2.rows).toHaveLength(0);
    // Injection attempts stay data.
    const evil = await h.call({ type: 'fetchTableRows', connectionId: id, queryId: 'p4', query: { database: 'dd_shop', table: 'customers', filter: { kind: 'group', id: 'r', combinator: 'and', children: [{ kind: 'condition', id: 'c', column: 'email', operator: 'eq', value: "x' OR '1'='1" }] }, limit: 10, offset: 0 } });
    expect(evil.rows).toHaveLength(0);
    // Visual query with a join and aggregate.
    const run = await h.call({
      type: 'runQueryModel',
      connectionId: id,
      queryId: 'qb',
      model: {
        tables: [
          { alias: 'c', database: 'dd_shop', table: 'customers' },
          { alias: 'o', database: 'dd_shop', table: 'orders' },
        ],
        joins: [{ id: 'j', type: 'left', leftAlias: 'c', leftColumn: 'id', rightAlias: 'o', rightColumn: 'customer_id' }],
        columns: [
          { id: '1', source: 'c', column: 'status' },
          { id: '2', source: 'o', column: 'total', aggregate: 'sum', as: 'revenue' },
        ],
        filter: { kind: 'group', id: 'r', combinator: 'and', children: [] },
        groupBy: [],
        orderBy: [{ source: 'c', column: 'status', direction: 'asc' }],
        limit: 10,
        distinct: false,
      },
    });
    expect(run.statement.error).toBeUndefined();
    expect(run.statement.result!.rows.map((r) => r[0])).toEqual(['active', 'inactive']);
    // Metadata + data search.
    const meta = await h.call({ type: 'searchMetadata', term: 'CUSTOMER', limit: 50 });
    expect(meta.hits.some((x) => x.kind === 'table' && x.table === 'customers' && x.database === 'dd_shop')).toBe(true);
    expect(meta.hits.some((x) => x.kind === 'column' && x.column === 'customer_id' && x.database === 'dd_nofk')).toBe(true);
    // Edits commit in a transaction; a row that disappeared rolls the batch back.
    const edit = await h.call({ type: 'applyEdits', connectionId: id, database: 'dd_shop', table: 'customers', updates: [{ key: { id: 1 }, changes: { status: 'vip' } }], deletes: [] });
    expect(edit).toMatchObject({ committed: true, affectedRows: 1 });
    await expect(
      h.call({ type: 'applyEdits', connectionId: id, database: 'dd_shop', table: 'customers', updates: [{ key: { id: 2 }, changes: { status: 'zzz' } }, { key: { id: 99999 }, changes: { status: 'zzz' } }], deletes: [] }),
    ).rejects.toThrow(/rolled back/);
    const [check] = await admin.query('SELECT status FROM dd_shop.customers WHERE id IN (1, 2) ORDER BY id');
    expect((check as { status: string }[]).map((r) => r.status)).toEqual(['vip', 'active']);
    await h.manager.disconnectAll();
  });

  it('runs read-only statements in a read-only transaction', async () => {
    await expect(driver.query("INSERT INTO dd_shop.customers (email) VALUES ('ro@x.io')", [], { ...opts, readOnly: true })).rejects.toMatchObject({ code: 'READ_ONLY' });
    const r = await driver.query('SELECT COUNT(*) AS n FROM dd_shop.customers', [], { ...opts, readOnly: true });
    expect(Number(r.rows[0]![0])).toBe(120);
  });

  it('uses the requested default database per statement', async () => {
    const r = await driver.query('SELECT DATABASE(), COUNT(*) FROM customers', [], { ...opts, database: 'dd_shop' });
    expect(r.rows[0]![0]).toBe('dd_shop');
    const r2 = await driver.query('SELECT DATABASE()', [], opts);
    expect(r2.rows[0]![0]).toBeNull();
  });

  it('truncates large results without keeping every row in memory', async () => {
    const r = await driver.query('SELECT a.id FROM dd_shop.customers a CROSS JOIN dd_shop.customers b', [], { ...opts, maxRows: 50 });
    expect(r.rows).toHaveLength(50);
    expect(r.truncated).toBe(true);
    const after = await driver.query('SELECT 1', [], opts);
    expect(after.rows).toEqual([[1]]);
  });

  it('times out and kills long-running queries on the server', async () => {
    const started = Date.now();
    await expect(driver.query('SELECT SLEEP(5)', [], { ...opts, timeoutMs: 400 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 300));
    const [procs] = await admin.query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP(5)%'");
    expect(Number((procs as { n: number }[])[0]!.n)).toBe(0);
    expect((await driver.query('SELECT 2', [], opts)).rows).toEqual([[2]]);
  });

  it('cancels queries via AbortSignal', async () => {
    const ac = new AbortController();
    const p = driver.query('SELECT SLEEP(5)', [], { ...opts, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await driver.query('SELECT 3', [], opts)).rows).toEqual([[3]]);
  });

  it('keeps multiple independent connections', async () => {
    const other = new MysqlDriver(config({ id: 'other', database: 'dd_nofk' }), password, { poolSize: 1 });
    await other.connect();
    const [a, b] = await Promise.all([driver.query('SELECT DATABASE()', [], { ...opts, database: 'dd_shop' }), other.query('SELECT DATABASE()', [], opts)]);
    expect(a.rows[0]![0]).toBe('dd_shop');
    expect(b.rows[0]![0]).toBe('dd_nofk');
    await other.close();
    await expect(other.query('SELECT 1', [], opts)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('locates a table and column across databases', async () => {
    // System schemas can match too (performance_schema has a users table); the UI hides them by default.
    const ours = (l: TableLocation[]) => l.filter((x) => x.database.startsWith('dd_'));
    expect(ours(await driver.locateTable('users'))).toEqual([{ database: 'dd_t1' }, { database: 'dd_t2' }]);
    expect(ours(await driver.locateTable('users', 'is_active'))).toEqual([
      { database: 'dd_t1', hasColumn: false },
      { database: 'dd_t2', hasColumn: true },
    ]);
  });

  it('runs a migration on several databases, skipping and grouping failures', async () => {
    const h = await createHarness({ mysql: (c, pw) => new MysqlDriver(c, pw, { poolSize: 2 }) });
    const s = await h.call({ type: 'saveConnection', config: mysqlInput({ host, port, user, readOnly: false }), password });
    await h.call({ type: 'connect', connectionId: s.config.id });
    await h.call({
      type: 'runSqlMulti',
      connectionId: s.config.id,
      runId: 'mysql-run',
      sql: 'ALTER TABLE users ADD COLUMN is_active TINYINT NOT NULL DEFAULT 1; UPDATE users SET is_active = 1',
      databases: ['dd_t1', 'dd_t2', 'dd_t3'],
      concurrency: 1,
    });
    let summary;
    for (let i = 0; i < 200 && !summary; i++) {
      summary = h.events.flatMap((e) => (e.type === 'multiRunFinished' ? [e.summary] : []))[0];
      if (!summary) await new Promise((r) => setTimeout(r, 25));
    }
    expect(summary!.counts).toEqual({ succeeded: 1, failed: 2, partial: 0, not_run: 0 });
    expect(summary!.errorGroups.map((g) => [g.code, g.message, g.databases])).toEqual([
      ['ER_DUP_FIELDNAME', "Duplicate column name 'is_active'", ['dd_t2']],
      ['ER_NO_SUCH_TABLE', "Table '<db>.users' doesn't exist", ['dd_t3']],
    ]);
    // The change landed in the database it was meant for, and only there.
    const [rows] = await admin.query("SELECT TABLE_SCHEMA AS db FROM information_schema.COLUMNS WHERE TABLE_NAME = 'users' AND COLUMN_NAME = 'is_active' ORDER BY 1");
    expect((rows as { db: string }[]).map((r) => r.db)).toEqual(['dd_t1', 'dd_t2']);
    const [t1] = await admin.query('SELECT is_active FROM dd_t1.users');
    expect((t1 as { is_active: number }[]).every((r) => r.is_active === 1)).toBe(true);
    await h.call({ type: 'disconnect', connectionId: s.config.id });
  });

  it('reports bad credentials and unreachable servers without leaking secrets', async () => {
    const bad = new MysqlDriver(config(), 'wrong-secret-pw', { poolSize: 1 });
    const err = await bad.connect().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Access denied/);
    expect((err as Error).message).not.toContain('wrong-secret-pw');
    const down = new MysqlDriver(config({ port: 1 }), password, { poolSize: 1 });
    await expect(down.connect()).rejects.toThrow(/refused|Timed out/);
  });
});
