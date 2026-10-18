import type { HistoryEntry, SavedQuery, SavedQueryInput } from '../../shared/model';
import { DeepDiveError, validationError } from '../errors';

/** Persists plain JSON values (VS Code globalState in production). */
export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): Promise<void>;
}

const SAVED_KEY = 'deepdive.savedQueries.v1';
const HISTORY_KEY = 'deepdive.queryHistory.v1';
/** Longer scripts (dumps, generated SQL) are not worth keeping in history. */
export const MAX_HISTORY_SQL = 100_000;

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

function loadArray<T extends { id: string; sql: string }>(store: KeyValueStore, key: string): T[] {
  const raw = store.get(key);
  return Array.isArray(raw) ? (raw as T[]).filter((x) => x && typeof x.id === 'string' && typeof x.sql === 'string') : [];
}

/** Saved queries and the SQL editor run history. Free of VS Code APIs so it is unit-testable. */
export class QueryLibrary {
  private saved: SavedQuery[];
  private history: HistoryEntry[];

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {
    this.saved = loadArray<SavedQuery>(store, SAVED_KEY);
    this.history = loadArray<HistoryEntry>(store, HISTORY_KEY);
  }

  listSaved(): SavedQuery[] {
    return [...this.saved].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Creates a query, or updates the one with `input.id`. Names are unique, ignoring case. */
  async save(input: SavedQueryInput): Promise<SavedQuery> {
    const name = input.name.trim();
    if (!name) throw validationError('A saved query needs a name');
    if (!input.sql.trim()) throw validationError('Nothing to save: the query is empty');
    const existing = input.id ? this.saved.find((q) => q.id === input.id) : undefined;
    if (input.id && !existing) throw new DeepDiveError('This saved query no longer exists', 'NOT_FOUND');
    if (this.saved.some((q) => q.id !== existing?.id && q.name.toLowerCase() === name.toLowerCase())) {
      throw validationError(`A saved query named "${name}" already exists`);
    }
    const tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
    const description = input.description?.trim() || undefined;
    const now = this.now();
    const query: SavedQuery = existing
      ? { ...existing, name, description, tags, sql: input.sql, connectionId: input.connectionId, database: input.database, updatedAt: now }
      : { id: newId('sq'), name, description, tags, sql: input.sql, connectionId: input.connectionId, database: input.database, createdAt: now, updatedAt: now, runCount: 0 };
    this.saved = existing ? this.saved.map((q) => (q.id === query.id ? query : q)) : [...this.saved, query];
    await this.store.set(SAVED_KEY, this.saved);
    return query;
  }

  async deleteSaved(id: string): Promise<boolean> {
    const before = this.saved.length;
    this.saved = this.saved.filter((q) => q.id !== id);
    if (this.saved.length === before) return false;
    await this.store.set(SAVED_KEY, this.saved);
    return true;
  }

  /** Records that a saved query was run. Unknown ids are ignored (the query may have been deleted). */
  async markRun(id: string): Promise<void> {
    const q = this.saved.find((x) => x.id === id);
    if (!q) return;
    q.lastRunAt = this.now();
    q.runCount += 1;
    await this.store.set(SAVED_KEY, this.saved);
  }

  /** Newest first. */
  listHistory(opts: { term?: string; connectionId?: string; limit: number }): HistoryEntry[] {
    const term = opts.term?.trim().toLowerCase();
    return this.history
      .filter((h) => (!opts.connectionId || h.connectionId === opts.connectionId) && (!term || h.sql.toLowerCase().includes(term)))
      .slice(0, opts.limit);
  }

  /**
   * Adds a run to the history. A run identical to the newest entry (same SQL, connection, database
   * and target count) updates that entry instead of adding a new one.
   */
  async record(entry: Omit<HistoryEntry, 'id' | 'runs' | 'executedAt'>, maxEntries: number): Promise<HistoryEntry | undefined> {
    if (entry.sql.length > MAX_HISTORY_SQL || !entry.sql.trim()) return undefined;
    const head = this.history[0];
    const executedAt = this.now();
    let recorded: HistoryEntry;
    if (head && head.sql === entry.sql && head.connectionId === entry.connectionId && head.database === entry.database && head.databaseCount === entry.databaseCount) {
      recorded = { ...head, ...entry, executedAt, runs: head.runs + 1 };
      this.history = [recorded, ...this.history.slice(1)];
    } else {
      recorded = { ...entry, id: newId('h'), executedAt, runs: 1 };
      this.history = [recorded, ...this.history].slice(0, Math.max(1, maxEntries));
    }
    await this.store.set(HISTORY_KEY, this.history);
    return recorded;
  }

  async deleteHistoryEntry(id: string): Promise<boolean> {
    const before = this.history.length;
    this.history = this.history.filter((h) => h.id !== id);
    if (this.history.length === before) return false;
    await this.store.set(HISTORY_KEY, this.history);
    return true;
  }

  async clearHistory(): Promise<void> {
    this.history = [];
    await this.store.set(HISTORY_KEY, this.history);
  }
}
