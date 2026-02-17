import { useEffect, useRef } from "react";
import type { Edge, Node } from "reactflow";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";

type ForceNode = {
  id: string;
  x?: number;
  y?: number;
  r?: number;
};

type ForceLink = {
  source: string;
  target: string;
  weight?: number;
};

export function useForceLayout(opts: {
  enabled: boolean;
  nodes: Node[];
  edges: Edge[];
  setNodes: (updater: (prev: Node[]) => Node[]) => void;
  ticks?: number;
}) {
  const running = useRef(false);

  useEffect(() => {
    if (!opts.enabled) return;
    if (running.current) return;
    if (!opts.nodes.length) return;

    running.current = true;

    const ticks = Number.isFinite(opts.ticks as any) ? Number(opts.ticks) : 300;

    // Clone into d3 mutable objects.
    const simNodes: ForceNode[] = opts.nodes.map((n) => ({
      id: n.id,
      x: Number.isFinite((n.position as any)?.x) ? (n.position as any).x : undefined,
      y: Number.isFinite((n.position as any)?.y) ? (n.position as any).y : undefined,
      r: Number.isFinite((n.data as any)?.sizePx)
        ? Math.max(30, Math.min(80, Number((n.data as any).sizePx) / 2))
        : 60
    }));

    const simLinks: ForceLink[] = opts.edges.map((e: any) => ({
      source: String(e.source),
      target: String(e.target),
      weight: typeof e.weight === "number" ? e.weight : undefined
    }));

    const sim = forceSimulation(simNodes as any)
      .force("charge", forceManyBody().strength(-1000))
      .force(
        "link",
        forceLink(simLinks as any)
          .id((d: any) => d.id)
          .distance(150)
          .strength(0.8)
      )
      .force("center", forceCenter(0, 0))
      .force(
        "collide",
        forceCollide((d: any) => {
          const r = typeof d.r === "number" ? d.r : 60;
          return r + 20;
        }).iterations(2)
      );

    // Run synchronously; do NOT animate every tick.
    for (let i = 0; i < ticks; i++) sim.tick();
    sim.stop();

    const posById = new Map<string, { x: number; y: number }>();
    for (const n of simNodes) {
      const x = Number.isFinite(n.x as any) ? Number(n.x) : 0;
      const y = Number.isFinite(n.y as any) ? Number(n.y) : 0;
      posById.set(n.id, { x, y });
    }

    opts.setNodes((prev) =>
      prev.map((n) => {
        const p = posById.get(n.id);
        if (!p) return n;
        return {
          ...n,
          position: { x: p.x, y: p.y }
        };
      })
    );

    running.current = false;
  }, [opts.enabled, opts.nodes.length, opts.edges.length]);
}
