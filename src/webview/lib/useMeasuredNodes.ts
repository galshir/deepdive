import type { Node, NodeChange } from '@xyflow/react';
import { useCallback, useMemo, useRef } from 'react';

/**
 * Our canvases derive nodes from store state instead of keeping React Flow's node state. Without the
 * measured size on each regenerated node, React Flow hides nodes for a frame to re-measure them (which
 * flickers and swallows double-clicks). This keeps the last measured size per node and re-attaches it.
 */
export function useMeasuredNodes<T extends Node>(nodes: T[]): { nodes: T[]; onNodesChange: (changes: NodeChange<T>[]) => void } {
  const sizes = useRef(new Map<string, { width: number; height: number }>());
  const onNodesChange = useCallback((changes: NodeChange<T>[]) => {
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) sizes.current.set(c.id, c.dimensions);
      if (c.type === 'remove') sizes.current.delete(c.id);
    }
  }, []);
  const measured = useMemo(
    () =>
      nodes.map((n) => {
        const m = sizes.current.get(n.id);
        return m ? { ...n, measured: m } : n;
      }),
    [nodes],
  );
  return { nodes: measured, onNodesChange };
}
