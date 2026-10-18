import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_COMPARE_OPTIONS } from '../../src/core/services/schemaDiff';
import type { ServerCompareProgress, ServerCompareRow } from '../../src/shared/model';
import type { HostEvent } from '../../src/shared/protocol';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let qa: string;
let staging: string;

const demo = (name: string) => ({
  name,
  color: '#22c55e',
  kind: 'demo' as const,
  demoDataset: 'acme' as const,
  environment: 'development' as const,
  host: 'demo.local',
  port: 3306,
  user: 'demo',
  readOnly: false,
  tls: { mode: 'disabled' as const },
  connectTimeoutMs: 10_000,
});

beforeAll(async () => {
  h = await createHarness();
  qa = (await h.call({ type: 'saveConnection', config: demo('QA'), password: null })).config.id;
  staging = (await h.call({ type: 'saveConnection', config: demo('Staging'), password: null })).config.id;
  await h.call({ type: 'connect', connectionId: qa });
  await h.call({ type: 'connect', connectionId: staging });
  // Staging drifts from QA: a new column and an extra table in shop, an extra index in hr.
  const drift = await h.call({
    type: 'runSql',
    connectionId: staging,
    queryId: 'drift',
    sql: 'ALTER TABLE customers ADD COLUMN loyalty_points INTEGER; CREATE TABLE shop.coupons (id INTEGER PRIMARY KEY, code TEXT); CREATE INDEX hr.ix_emp_name ON employees(full_name)',
  });
  expect(drift.statements.map((st) => st.error)).toEqual([undefined, undefined, undefined]);
});

async function serverCompare(compareId: string) {
  await h.call({ type: 'compareServers', compareId, sourceConnectionId: qa, targetConnectionId: staging, options: DEFAULT_COMPARE_OPTIONS });
  for (let i = 0; i < 400; i++) {
    const events = h.events.flatMap((e: HostEvent) => (e.type === 'serverCompareProgress' && e.progress.compareId === compareId ? [e.progress] : []));
    const last: ServerCompareProgress | undefined = events.at(-1);
    if (last?.finished) return { last, rows: events.flatMap((p) => p.rows ?? []) };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('comparison did not finish');
}

describe('schema compare', () => {
  it('compares two databases and lists what is missing on each side', async () => {
    const diff = await h.call({ type: 'compareSchemas', source: { connectionId: qa, database: 'shop' }, target: { connectionId: staging, database: 'shop' }, options: DEFAULT_COMPARE_OPTIONS });
    expect(diff.summary.tables).toMatchObject({ only_source: 0, only_target: 1, changed: 1 });
    expect(diff.tables.find((t) => t.name === 'coupons')!.status).toBe('only_target');
    const customers = diff.tables.find((t) => t.name === 'customers')!;
    expect(customers.status).toBe('changed');
    expect(customers.columns.filter((c) => c.status !== 'same').map((c) => [c.name, c.status])).toEqual([['loyalty_points', 'only_target']]);
    // Swapping sides swaps the direction.
    const back = await h.call({ type: 'compareSchemas', source: { connectionId: staging, database: 'shop' }, target: { connectionId: qa, database: 'shop' }, options: DEFAULT_COMPARE_OPTIONS });
    expect(back.summary.tables).toMatchObject({ only_source: 1, only_target: 0, changed: 1 });
  });

  it('compares whole servers database by database', async () => {
    const { last, rows } = await serverCompare('cmp1');
    expect(last).toMatchObject({ done: 4, total: 4, cancelled: false });
    const byDb = Object.fromEntries(rows.map((r: ServerCompareRow) => [r.database, r.status]));
    expect(byDb).toEqual({ shop: 'changed', analytics: 'same', hr: 'changed', sandbox: 'same' });
    expect(rows.find((r) => r.database === 'hr')!.summary!.objects.only_target).toBe(1);
  });

  it('validates the inputs', async () => {
    await expect(h.call({ type: 'compareSchemas', source: { connectionId: qa, database: 'shop' }, target: { connectionId: qa, database: 'shop' }, options: DEFAULT_COMPARE_OPTIONS })).rejects.toThrow(/two different databases/);
    await expect(h.call({ type: 'compareSchemas', source: { connectionId: qa, database: 'shop' }, target: { connectionId: staging, database: 'nope' }, options: DEFAULT_COMPARE_OPTIONS })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.call({ type: 'compareServers', compareId: 'x', sourceConnectionId: qa, targetConnectionId: qa, options: DEFAULT_COMPARE_OPTIONS })).rejects.toThrow(/two different connections/);
  });

  it('only generates sync scripts between MySQL connections', async () => {
    await expect(
      h.call({ type: 'generateSyncScript', source: { connectionId: qa, database: 'shop' }, target: { connectionId: staging, database: 'shop' }, options: DEFAULT_COMPARE_OPTIONS, includeDrops: false }),
    ).rejects.toThrow(/MySQL connections/);
  });
});
