import { DeepDiveError } from '../errors';

interface Running {
  controller: AbortController;
  connectionId: string;
}

/** Tracks running queries so the UI can cancel them and disconnects can abort them. */
export class QueryRegistry {
  private readonly running = new Map<string, Running>();

  async run<T>(queryId: string, connectionId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running.has(queryId)) throw new DeepDiveError('A query with this id is already running', 'VALIDATION');
    const controller = new AbortController();
    this.running.set(queryId, { controller, connectionId });
    try {
      return await fn(controller.signal);
    } finally {
      this.running.delete(queryId);
    }
  }

  cancel(queryId: string): boolean {
    const r = this.running.get(queryId);
    if (!r) return false;
    r.controller.abort();
    return true;
  }

  cancelConnection(connectionId: string): number {
    let n = 0;
    for (const r of this.running.values()) {
      if (r.connectionId === connectionId) {
        r.controller.abort();
        n++;
      }
    }
    return n;
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.controller.abort();
  }

  count(): number {
    return this.running.size;
  }
}
