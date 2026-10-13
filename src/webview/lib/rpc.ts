import type { HostEvent, HostToWebview, RequestOf, RequestType, ResponseMap } from '../../shared/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = acquireVsCodeApi();

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let seq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const listeners = new Set<(e: HostEvent) => void>();

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as HostToWebview | undefined;
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'response') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new RpcError(msg.error.message, msg.error.code));
  } else if (msg.kind === 'event') {
    for (const l of listeners) l(msg.event);
  }
});

/** Sends a typed request to the extension host. */
export function rpc<T extends RequestType>(payload: RequestOf<T>): Promise<ResponseMap[T]> {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    api.postMessage({ kind: 'request', id, payload });
  });
}

export function onHostEvent(listener: (e: HostEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
