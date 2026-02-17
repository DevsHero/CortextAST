import React from "react";
import { BaseEdge, EdgeLabelRenderer, MarkerType, getBezierPath, type EdgeProps } from "reactflow";

export function NetworkEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });

  const w = typeof (data as any)?.weight === "number" ? Number((data as any).weight) : 1;
  const strokeWidth = Math.max(1, Math.min(6, 1 + w * 0.6));

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={MarkerType.ArrowClosed}
        style={{
          stroke: "rgba(180, 180, 180, 0.45)",
          strokeWidth
        }}
      />
      <EdgeLabelRenderer>{/* no labels */}</EdgeLabelRenderer>
    </>
  );
}
