import type { DatabaseInfo, DatabaseSchema, TableDetails, TableInfo } from '../../shared/model';
import type { DbDriver } from '../drivers/driver';

type Loader<T> = () => Promise<T>;

/**
 * Lazily loads and caches schema metadata per connection. Concurrent requests for the same entry share
 * one in-flight promise; failures are not cached. `invalidate` clears a connection or a single database.
 */
export class MetadataService {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly driverFor: (connectionId: string) => DbDriver) {}

  private key(...parts: string[]): string {
    return parts.join('\u0000');
  }

  private cached<T>(key: string, refresh: boolean | undefined, load: Loader<T>): Promise<T> {
    if (!refresh) {
      const hit = this.cache.get(key);
      if (hit) return hit as Promise<T>;
    }
    const p = load();
    this.cache.set(key, p);
    p.catch(() => {
      if (this.cache.get(key) === p) this.cache.delete(key);
    });
    return p;
  }

  databases(connectionId: string, refresh?: boolean): Promise<DatabaseInfo[]> {
    const driver = this.driverFor(connectionId);
    if (refresh) this.invalidate(connectionId);
    return this.cached(this.key(connectionId, 'dbs'), refresh, () => driver.listDatabases());
  }

  tables(connectionId: string, database: string, refresh?: boolean): Promise<TableInfo[]> {
    const driver = this.driverFor(connectionId);
    if (refresh) this.invalidate(connectionId, database);
    return this.cached(this.key(connectionId, 'tables', database), refresh, () => driver.listTables(database));
  }

  tableDetails(connectionId: string, database: string, table: string, refresh?: boolean): Promise<TableDetails> {
    const driver = this.driverFor(connectionId);
    return this.cached(this.key(connectionId, 'table', database, table), refresh, () => driver.loadTableDetails(database, table));
  }

  schema(connectionId: string, database: string, refresh?: boolean): Promise<DatabaseSchema> {
    const driver = this.driverFor(connectionId);
    return this.cached(this.key(connectionId, 'schema', database), refresh, () => driver.loadDatabaseSchema(database));
  }

  invalidate(connectionId: string, database?: string): void {
    const prefix = this.key(connectionId, '');
    for (const k of [...this.cache.keys()]) {
      if (!k.startsWith(prefix)) continue;
      if (database === undefined) {
        this.cache.delete(k);
        continue;
      }
      const parts = k.split('\u0000');
      if (parts[1] === 'dbs' || parts[2] === database) this.cache.delete(k);
    }
  }

  size(): number {
    return this.cache.size;
  }
}
