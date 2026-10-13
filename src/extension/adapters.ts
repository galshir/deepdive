import * as vscode from 'vscode';
import type { ConnectionStore, SecretStore } from '../core/services/connectionManager';
import type { Settings } from '../core/settings';
import { DEFAULT_SETTINGS } from '../core/settings';
import type { ConnectionConfig } from '../shared/model';

const CONNECTIONS_KEY = 'deepdive.connections.v1';

export class GlobalStateConnectionStore implements ConnectionStore {
  constructor(private readonly memento: vscode.Memento) {}

  load(): ConnectionConfig[] {
    const raw = this.memento.get<unknown>(CONNECTIONS_KEY);
    return Array.isArray(raw) ? (raw as ConnectionConfig[]).filter((c) => c && typeof c.id === 'string') : [];
  }

  async save(configs: ConnectionConfig[]): Promise<void> {
    await this.memento.update(CONNECTIONS_KEY, configs);
  }
}

export class VscodeSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('deepdive');
  const d = DEFAULT_SETTINGS;
  return {
    queryTimeoutMs: clamp(c.get('queryTimeoutMs'), 1000, 3_600_000, d.queryTimeoutMs),
    maxResultRows: clamp(c.get('maxResultRows'), 1, 100_000, d.maxResultRows),
    pageSize: clamp(c.get('pageSize'), 10, 5000, d.pageSize),
    maxActiveConnections: clamp(c.get('maxActiveConnections'), 1, 64, d.maxActiveConnections),
    poolSize: clamp(c.get('poolSize'), 1, 32, d.poolSize),
    maxTablesPerDatabase: clamp(c.get('graph.maxTablesPerDatabase'), 10, 5000, d.maxTablesPerDatabase),
    maxTablesPerDataSearch: clamp(c.get('search.maxTablesPerDataSearch'), 1, 500, d.maxTablesPerDataSearch),
  };
}
