import { errorMessage, rpc } from '../../lib/rpc';
import { uid } from '../../lib/util';
import { type CompareSide, useStore } from '../../store';
import type { SideNames } from './compareUtil';

/** Names shown for the two sides: connection names, or database names when both sides share a connection. */
export function useSideNames(source: CompareSide, target: CompareSide, level: 'schema' | 'server'): SideNames {
  const connections = useStore((s) => s.connections);
  const conn = (id?: string) => connections.find((c) => c.config.id === id)?.config.name ?? 'removed connection';
  if (level === 'server' || source.connectionId !== target.connectionId) {
    return { source: conn(source.connectionId), target: conn(target.connectionId) };
  }
  return { source: source.database ?? 'source', target: target.database ?? 'target' };
}

export async function compareSchemas(source?: CompareSide, target?: CompareSide): Promise<void> {
  const st = useStore.getState();
  const c = st.compare;
  const s = source ?? c.source;
  const t = target ?? c.target;
  if (!s.connectionId || !s.database || !t.connectionId || !t.database) return;
  st.updateCompare({ schema: { loading: true, diff: c.schema?.diff } });
  try {
    const diff = await rpc({ type: 'compareSchemas', source: { connectionId: s.connectionId, database: s.database }, target: { connectionId: t.connectionId, database: t.database }, options: c.options });
    useStore.getState().updateCompare({ schema: { loading: false, diff } });
  } catch (err) {
    useStore.getState().updateCompare({ schema: { loading: false, error: errorMessage(err) } });
  }
}

export async function compareServers(): Promise<void> {
  const c = useStore.getState().compare;
  const { connectionId: sourceConnectionId } = c.source;
  const { connectionId: targetConnectionId } = c.target;
  if (!sourceConnectionId || !targetConnectionId) return;
  const compareId = uid('cmp');
  // Created before the request so progress events that overtake the response are not lost.
  useStore.getState().updateCompare({ server: { compareId, sourceConnectionId, targetConnectionId, running: true, done: 0, total: 0, rows: [] } });
  try {
    await rpc({ type: 'compareServers', compareId, sourceConnectionId, targetConnectionId, options: c.options });
  } catch (err) {
    useStore.getState().updateCompare((x) => (x.server?.compareId === compareId ? { server: { ...x.server, running: false, error: errorMessage(err) } } : {}));
  }
}
