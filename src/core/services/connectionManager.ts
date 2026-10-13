import type { ConnectionConfig, ConnectionStatus, ConnectionSummary } from '../../shared/model';
import type { ConnectionInput } from '../../shared/protocol';
import type { DbDriver } from '../drivers/driver';
import { DeepDiveError, toSafeMessage, validationError } from '../errors';
import type { Settings } from '../settings';

/** Persists non-secret connection settings (VS Code globalState in production). */
export interface ConnectionStore {
  load(): ConnectionConfig[];
  save(configs: ConnectionConfig[]): Promise<void>;
}

/** Stores passwords (VS Code SecretStorage in production). */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type DriverFactory = (config: ConnectionConfig, password: string | undefined, settings: Settings) => DbDriver;

interface Session {
  driver: DbDriver;
  serverVersion: string;
}

interface State {
  status: ConnectionStatus;
  error?: string;
}

const secretKey = (id: string) => `deepdive.password.${id}`;

export function newId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Owns connection configs, secrets and live driver sessions. Free of VS Code APIs so it is unit-testable. */
export class ConnectionManager {
  private configs: ConnectionConfig[];
  private readonly sessions = new Map<string, Session>();
  private readonly states = new Map<string, State>();
  private readonly pending = new Map<string, Promise<ConnectionSummary>>();
  private readonly hasPassword = new Map<string, boolean>();
  private readonly listeners = new Set<() => void>();
  /** Passwords seen in this session, used only to redact error messages. */
  private readonly knownSecrets = new Set<string>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly secrets: SecretStore,
    private readonly createDriver: DriverFactory,
    private readonly settings: () => Settings,
  ) {
    this.configs = store.load();
  }

  async init(): Promise<void> {
    await Promise.all(
      this.configs.map(async (c) => {
        const pw = await this.secrets.get(secretKey(c.id));
        if (pw) this.knownSecrets.add(pw);
        this.hasPassword.set(c.id, Boolean(pw));
      }),
    );
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  redact(err: unknown): string {
    return toSafeMessage(err, [...this.knownSecrets]);
  }

  getConfig(id: string): ConnectionConfig {
    const c = this.configs.find((x) => x.id === id);
    if (!c) throw new DeepDiveError('Unknown connection', 'NOT_FOUND');
    return c;
  }

  summary(id: string): ConnectionSummary {
    const config = this.getConfig(id);
    const state = this.states.get(id) ?? { status: 'disconnected' as const };
    return {
      config,
      status: state.status,
      error: state.error,
      hasPassword: this.hasPassword.get(id) ?? false,
      serverVersion: this.sessions.get(id)?.serverVersion,
    };
  }

  list(): ConnectionSummary[] {
    return this.configs.map((c) => this.summary(c.id));
  }

  private normalize(input: ConnectionInput, id: string): ConnectionConfig {
    if (input.kind === 'mysql' && !input.host) throw validationError('Host is required');
    if (input.kind === 'mysql' && !input.user) throw validationError('User is required');
    if (input.tls.mode === 'disabled' && (input.tls.caPath || input.tls.certPath || input.tls.keyPath)) {
      throw validationError('TLS files are set but TLS is disabled');
    }
    const blank = (s?: string) => (s && s.trim() ? s.trim() : undefined);
    return {
      id,
      name: input.name.trim(),
      color: input.color,
      kind: input.kind,
      demoDataset: input.kind === 'demo' ? (input.demoDataset ?? 'acme') : undefined,
      environment: input.environment,
      host: input.host.trim(),
      port: input.port,
      user: input.user,
      database: blank(input.database),
      readOnly: input.readOnly,
      tls: { mode: input.tls.mode, caPath: blank(input.tls.caPath), certPath: blank(input.tls.certPath), keyPath: blank(input.tls.keyPath) },
      connectTimeoutMs: input.connectTimeoutMs,
    };
  }

  /** password: undefined keeps the stored secret, null removes it, string replaces it. */
  async save(input: ConnectionInput, password?: string | null): Promise<ConnectionSummary> {
    const existing = input.id ? this.configs.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) throw new DeepDiveError('Unknown connection', 'NOT_FOUND');
    const config = this.normalize(input, existing?.id ?? newId());
    if (this.configs.some((c) => c.id !== config.id && c.name.toLowerCase() === config.name.toLowerCase())) {
      throw validationError(`A connection named "${config.name}" already exists`);
    }
    if (typeof password === 'string' && password.length > 0) {
      await this.secrets.store(secretKey(config.id), password);
      this.knownSecrets.add(password);
      this.hasPassword.set(config.id, true);
    } else if (password === null || (typeof password === 'string' && password.length === 0 && !existing)) {
      await this.secrets.delete(secretKey(config.id));
      this.hasPassword.set(config.id, false);
    }
    this.configs = existing ? this.configs.map((c) => (c.id === config.id ? config : c)) : [...this.configs, config];
    await this.store.save(this.configs);
    // Settings changed: drop the old session so the next connect uses the new configuration.
    if (existing && this.sessions.has(config.id)) await this.disconnect(config.id);
    this.changed();
    return this.summary(config.id);
  }

  async remove(id: string): Promise<void> {
    this.getConfig(id);
    await this.disconnect(id);
    await this.secrets.delete(secretKey(id));
    this.configs = this.configs.filter((c) => c.id !== id);
    this.states.delete(id);
    this.hasPassword.delete(id);
    await this.store.save(this.configs);
    this.changed();
  }

  /** Opens a throwaway session to verify settings. Never persists anything. */
  async test(input: ConnectionInput, password?: string | null): Promise<string> {
    const config = this.normalize(input, input.id ?? 'test');
    const pw = typeof password === 'string' && password.length > 0 ? password : password === null ? undefined : input.id ? await this.secrets.get(secretKey(input.id)) : undefined;
    if (pw) this.knownSecrets.add(pw);
    const driver = this.createDriver(config, pw, this.settings());
    try {
      return await driver.connect();
    } catch (err) {
      throw new DeepDiveError(this.redact(err), errorCodeOf(err));
    } finally {
      await driver.close().catch(() => undefined);
    }
  }

  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  connect(id: string): Promise<ConnectionSummary> {
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const p = this.doConnect(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  private async doConnect(id: string): Promise<ConnectionSummary> {
    const config = this.getConfig(id);
    if (this.sessions.has(id)) return this.summary(id);
    const limit = this.settings().maxActiveConnections;
    if (this.sessions.size >= limit) {
      throw new DeepDiveError(`At most ${limit} connections can be open at once (setting deepdive.maxActiveConnections). Disconnect one first.`, 'LIMIT');
    }
    this.states.set(id, { status: 'connecting' });
    this.changed();
    const password = config.kind === 'mysql' ? await this.secrets.get(secretKey(id)) : undefined;
    const driver = this.createDriver(config, password, this.settings());
    try {
      const serverVersion = await driver.connect();
      this.sessions.set(id, { driver, serverVersion });
      this.states.set(id, { status: 'connected' });
      this.changed();
      return this.summary(id);
    } catch (err) {
      await driver.close().catch(() => undefined);
      const message = this.redact(err);
      this.states.set(id, { status: 'error', error: message });
      this.changed();
      throw new DeepDiveError(message, errorCodeOf(err));
    }
  }

  async disconnect(id: string): Promise<ConnectionSummary> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) await session.driver.close().catch(() => undefined);
    this.states.set(id, { status: 'disconnected' });
    this.changed();
    return this.summary(id);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  driver(id: string): DbDriver {
    const session = this.sessions.get(id);
    if (!session) {
      const name = this.configs.find((c) => c.id === id)?.name ?? 'This connection';
      throw new DeepDiveError(`${name} is not connected`, 'NOT_CONNECTED');
    }
    return session.driver;
  }

  /** Marks a connection as broken after a fatal driver error (e.g. the server went away). */
  markError(id: string, message: string): void {
    if (!this.configs.some((c) => c.id === id)) return;
    this.states.set(id, { status: this.sessions.has(id) ? 'connected' : 'error', error: message });
    this.changed();
  }
}

function errorCodeOf(err: unknown) {
  return err instanceof DeepDiveError ? err.code : 'CONNECTION';
}
