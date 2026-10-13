import { BaseEdge, type EdgeProps, type InternalNode, useInternalNode } from '@xyflow/react';

function centerAndSize(node: InternalNode) {
  const w = node.measured.width ?? node.width ?? 0;
  const h = node.measured.height ?? node.height ?? 0;
  return { x: node.internals.positionAbsolute.x + w / 2, y: node.internals.positionAbsolute.y + h / 2, w, h, shape: (node.data as { shape?: string }).shape };
}

/** Point where the ray from the node centre towards (tx, ty) leaves the node's shape. */
function border(n: ReturnType<typeof centerAndSize>, tx: number, ty: number) {
  const dx = tx - n.x;
  const dy = ty - n.y;
  const len = Math.hypot(dx, dy) || 1;
  if (n.shape === 'circle') {
    const r = n.w / 2;
    return { x: n.x + (dx / len) * r, y: n.y + (dy / len) * r };
  }
  const hw = n.w / 2;
  const hh = Math.min(n.h, 34) / 2;
  const scale = Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  return { x: n.x + dx * scale, y: n.y + dy * scale };
}

/** Straight edge between node borders, independent of handle positions — suits radial layouts. */
export function FloatingEdge({ id, source, target, style, markerEnd, interactionWidth }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const a = centerAndSize(s);
  const b = centerAndSize(t);
  const p1 = border(a, b.x, b.y);
  const p2 = border(b, a.x, a.y);
  return <BaseEdge id={id} path={`M ${p1.x},${p1.y} L ${p2.x},${p2.y}`} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth ?? 12} />;
}

export const edgeTypes = { floating: FloatingEdge };
