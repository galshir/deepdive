import { DemoDriver } from '../../src/core/drivers/demoDriver';
import type { DbDriver } from '../../src/core/drivers/driver';
import { MessageRouter, type HostBridge } from '../../src/core/router';
import { ConnectionManager, type ConnectionStore, type DriverFactory, type SecretStore } from '../../src/core/services/connectionManager';
import { MetadataService } from '../../src/core/services/metadataService';
import { QueryLibrary, type KeyValueStore } from '../../src/core/services/queryLibrary';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/settings';
import type { ConnectionConfig } from '../../src/shared/model';
import type { HostEvent, HostToWebview, Request, ResponseMap } from '../../src/shared/protocol';
import type { MysqlDriver } from '../../src/core/drivers/mysqlDriver';

export class MemoryStore implements ConnectionStore {
  configs: ConnectionConfig[] = [];
  load() {
    return [...this.configs];
  }
  async save(configs: ConnectionConfig[]) {
    this.configs = [...configs];
  }
}

export class MemorySecrets implements SecretStore {
  readonly map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k);
  }
  async store(k: string, v: string) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}

export class MemoryKeyValue implements KeyValueStore {
  readonly map = new Map<string, unknown>();
  get(k: string) {
    return structuredClone(this.map.get(k));
  }
  async set(k: string, v: unknown) {
    this.map.set(k, structuredClone(v));
  }
}

export interface Harness {
  router: MessageRouter;
  manager: ConnectionManager;
  metadata: MetadataService;
  events: HostEvent[];
  confirms: string[];
  setConfirm(answer: boolean): void;
  /** Answer for the typed (second-step) confirmation; defaults to true. */
  setTypedConfirm(answer: boolean): void;
  kv: MemoryKeyValue;
  library: QueryLibrary;
  settings: Settings;
  secrets: MemorySecrets;
  store: MemoryStore;
  call<T extends Request['type']>(payload: Extract<Request, { type: T }>): Promise<ResponseMap[T]>;
  raw(payload: unknown): Promise<HostToWebview | null>;
}

export async function createHarness(
  opts: { factory?: DriverFactory; settings?: Partial<Settings>; mysql?: (c: ConnectionConfig, pw?: string) => MysqlDriver; kv?: MemoryKeyValue } = {},
): Promise<Harness> {
  const store = new MemoryStore();
  const secrets = new MemorySecrets();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const factory: DriverFactory =
    opts.factory ?? ((config, pw) => (config.kind === 'demo' ? (new DemoDriver(config.demoDataset ?? 'acme') as DbDriver) : opts.mysql!(config, pw)));
  const manager = new ConnectionManager(store, secrets, factory, () => settings);
  await manager.init();
  const metadata = new MetadataService((id) => manager.driver(id));
  const events: HostEvent[] = [];
  const confirms: string[] = [];
  let answer = true;
  let typedAnswer = true;
  const kv = opts.kv ?? new MemoryKeyValue();
  const library = new QueryLibrary(kv);
  const bridge: HostBridge = {
    settings: () => settings,
    emit: (e) => events.push(e),
    confirm: async ({ title }) => {
      confirms.push(title);
      return answer;
    },
    confirmTyped: async ({ title }) => {
      confirms.push(`typed: ${title}`);
      return typedAnswer;
    },
    copyText: async () => undefined,
    openSqlDocument: async () => undefined,
    output: () => undefined,
  };
  const router = new MessageRouter(manager, metadata, bridge, library);
  let seq = 1;
  const raw = (payload: unknown) => router.handle({ kind: 'request', id: seq++, payload });
  return {
    router,
    manager,
    metadata,
    events,
    confirms,
    settings,
    secrets,
    store,
    setConfirm: (a) => (answer = a),
    setTypedConfirm: (a) => (typedAnswer = a),
    kv,
    library,
    raw,
    async call(payload) {
      const res = await raw(payload);
      if (!res || res.kind !== 'response') throw new Error('no response');
      if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
      return res.result as never;
    },
  };
}

export const mysqlInput = (patch: Record<string, unknown> = {}) => ({
  name: 'Local MySQL',
  color: '#3b82f6',
  kind: 'mysql' as const,
  environment: 'development' as const,
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  readOnly: true,
  tls: { mode: 'disabled' as const },
  connectTimeoutMs: 5000,
  ...patch,
});
