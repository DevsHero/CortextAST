import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, Edge, Node, ReactFlowInstance } from "reactflow";
import "reactflow/dist/style.css";
import { getVsCodeApi } from "./vscode";
import dagre from "dagre";
import {
  RotateCw,
  Zap,
  Settings,
  CircleHelp,
  ClipboardCopy,
  LayoutGrid,
  Search
} from "lucide-react";

import { FileNode, type FileNodeData, type UiChild, type UiSymbol } from "./FileNode";
import { ModuleNode } from "./ModuleNode";
import { useForceLayout } from "./hooks/useForceLayout";

type RustMap = {
  nodes: Array<{ id: string; label?: string; path?: string; size_class?: string; est_tokens?: number }>;
  edges: Array<{ source: string; target: string; id?: string }>;
};

type ModuleGraph = {
  nodes: Array<{ id: string; label: string; path: string; file_count: number; bytes: number; est_tokens: number }>;
  edges: Array<{ id: string; source: string; target: string; weight: number }>;
};

type ExtensionMessage =
  | { type: "UPDATE_GRAPH"; payload: RustMap }
  | { type: "STATUS"; text: string }
  | { type: "INSPECT_RESULT"; ok: boolean; targetPath: string; payload?: any; error?: string }
  | {
      type: "SLICE_RESULT";
      ok: boolean;
      target: string;
      outputPath?: string;
      xmlChars?: number;
      estTokens?: number;
      budgetTokens?: number;
      error?: string;
    };

const vscode = getVsCodeApi();

function isGroupNode(id: string): boolean {
  // Heuristic: top-level folders act as groups.
  return !id.includes("/");
}

function nodeBackground(id: string): string {
  // Visuals per prompt: Blue modules, Grey file groups.
  return isGroupNode(id) ? "#616161" : "#1976d2";
}

function nodeBorder(sizeClass?: string): string {
  // Red border for large modules.
  return sizeClass === "large" ? "2px solid #d32f2f" : "1px solid rgba(255,255,255,0.2)";
}

function isFileLikeId(id: string): boolean {
  const lower = id.toLowerCase();
  // Heuristic for "file nodes": ends with a known source/text extension.
  return [
    ".rs",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".json",
    ".md",
    ".toml"
  ].some((ext) => lower.endsWith(ext));
}

function nodeKindFromId(id: string): "file" | "directory" {
  return isFileLikeId(id) ? "file" : "directory";
}

function layoutWithDagre(map: RustMap): { nodes: Node[]; edges: Edge[] } {
  // Default layout direction can be toggled by UI.
  return layoutWithDagreDir(map, "LR");
}

function layoutWithDagreDir(map: RustMap, dir: "LR" | "TB"): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: dir, nodesep: 40, ranksep: 90 });

  const nodeWidth = 220;
  const nodeHeight = 44;

  for (const n of map.nodes || []) {
    g.setNode(n.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const e of map.edges || []) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const nodes: Node[] = (map.nodes || []).map((n) => {
    const p = g.node(n.id) as { x: number; y: number } | undefined;
    const x = (p?.x ?? 0) - nodeWidth / 2;
    const y = (p?.y ?? 0) - nodeHeight / 2;

    const id = n.id;
    const kind = nodeKindFromId(id);

    return {
      id: n.id,
      type: kind,
      position: { x, y },
      data: {
        kind,
        label: n.label ?? n.id,
        path: n.path ?? n.id,
        title: n.path ?? n.id,
        expanded: false,
        loading: false,
        symbols: undefined,
        children: undefined,
        budgetTokens: undefined
      } satisfies FileNodeData,
      style: {
        background: nodeBackground(n.id),
        color: "#fff",
        border: nodeBorder(n.size_class),
        borderRadius: 8,
        padding: 10,
        width: nodeWidth,
        zIndex: 0
      }
    };
  });

  const edges: Edge[] = (map.edges || []).map((e) => ({
    id: e.id ?? `${e.source}->${e.target}`,
    source: e.source,
    target: e.target
  }));

  return { nodes, edges };
}

function layoutFallbackGrid(map: RustMap): { nodes: Node[]; edges: Edge[] } {
  const nodeWidth = 220;
  const nodeHeight = 44;
  const gapX = 70;
  const gapY = 60;
  const cols = 6;

  const nodes: Node[] = (map.nodes || []).map((n, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = col * (nodeWidth + gapX);
    const y = row * (nodeHeight + gapY);

    const id = n.id;
    const kind = nodeKindFromId(id);

    return {
      id: n.id,
      type: kind,
      position: { x, y },
      data: {
        kind,
        label: n.label ?? n.id,
        path: n.path ?? n.id,
        title: n.path ?? n.id,
        expanded: false,
        loading: false,
        symbols: undefined,
        children: undefined,
        budgetTokens: undefined
      } satisfies FileNodeData,
      style: {
        background: nodeBackground(n.id),
        color: "#fff",
        border: nodeBorder(n.size_class),
        borderRadius: 8,
        padding: 10,
        width: nodeWidth,
        zIndex: 0
      }
    };
  });

  const edges: Edge[] = (map.edges || []).map((e) => ({
    id: e.id ?? `${e.source}->${e.target}`,
    source: e.source,
    target: e.target
  }));

  return { nodes, edges };
}

export function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [status, setStatus] = useState<string>("Initializing...");
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEstTokens, setSelectedEstTokens] = useState<number | null>(null);

  const [budgetTokens, setBudgetTokens] = useState<number>(32000);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  const [layoutDir, setLayoutDir] = useState<"LR" | "TB">("LR");
  const [lastMap, setLastMap] = useState<RustMap | null>(null);

  const [viewMode, setViewMode] = useState<"files" | "modules">("files");

  const [search, setSearch] = useState<string>("");

  const [winSize, setWinSize] = useState<{ w: number; h: number }>(() => ({
    w: window.innerWidth,
    h: window.innerHeight
  }));
  const [zoom, setZoom] = useState<number>(1);
  const lastMoveLogAt = useRef<number>(0);
  const inspectInFlight = useRef<Set<string>>(new Set());
  const mapScopeInFlight = useRef<{ containerId: string; targetPath: string } | null>(null);
  const inspectScopeInFlight = useRef<{ containerId: string; targetPath: string } | null>(null);

  const onOpenAt = (file: string, line: number) => {
    console.log("[AnvilHolo] openFileAt", { file, line });
    vscode.postMessage({ command: "openFileAt", file, line });
  };

  const onSlicePath = (path: string) => {
    vscode.postMessage({ command: "focusNode", target: path, budgetTokens, action: "open" });
  };

  const onTogglePrivate = (containerId: string) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== containerId) return n;
        const cur = Boolean((n.data as any)?.showPrivate);
        return { ...n, data: { ...(n.data as any), showPrivate: !cur } };
      })
    );
  };

  const onToggle = (containerId: string) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== containerId) return n;
        const expanded = !Boolean((n.data as any)?.expanded);
        return {
          ...n,
          data: { ...(n.data as any), expanded },
          style: {
            ...(n.style as any),
            zIndex: expanded ? 1000 : 0
          }
        };
      })
    );
  };

  const onInspectPath = (containerId: string, targetPath: string) => {
    if (inspectInFlight.current.has(containerId)) return;
    inspectInFlight.current.add(containerId);
    inspectScopeInFlight.current = { containerId, targetPath };
    console.log("[AnvilHolo] inspectNode", { containerId, targetPath });

    const label = targetPath.split("/").filter(Boolean).pop() ?? targetPath;

    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== containerId) return n;
        return {
          ...n,
          data: {
            ...(n.data as any),
            kind: "file",
            label,
            path: targetPath,
            title: targetPath,
            loading: true,
            expanded: true
          } satisfies FileNodeData,
          style: { ...(n.style as any), zIndex: 1000 }
        };
      })
    );

    vscode.postMessage({ command: "inspectNode", targetPath });
  };

  const onExpandFolderPath = (containerId: string, targetPath: string) => {
    console.log("[AnvilHolo] folderExpand", { containerId, targetPath });
    mapScopeInFlight.current = { containerId, targetPath };

    const label = targetPath === "." ? "." : targetPath.split("/").filter(Boolean).pop() ?? targetPath;

    setNodes((prev) =>
      prev.map((n) => {
        if (n.id !== containerId) return n;
        return {
          ...n,
          data: {
            ...(n.data as any),
            kind: "directory",
            label,
            path: targetPath,
            title: targetPath,
            loading: true,
            expanded: true,
            children: []
          } satisfies FileNodeData,
          style: { ...(n.style as any), zIndex: 1000 }
        };
      })
    );

    vscode.postMessage({ command: "refreshMap", budgetTokens, targetPath });
  };

  const onToggleView = () => {
    setViewMode((m) => (m === "files" ? "modules" : "files"));
  };

  useForceLayout({
    enabled: viewMode === "modules",
    nodes,
    edges,
    setNodes
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as ExtensionMessage;
      if (msg.type === "UPDATE_GRAPH") {
        try {
          console.log("[AnvilHolo] UPDATE_GRAPH", {
            nodes: msg.payload?.nodes?.length,
            edges: msg.payload?.edges?.length
          });
          const scope = mapScopeInFlight.current;
          mapScopeInFlight.current = null;

          // Module network view: replace nodes/edges and let force layout place them.
          if (viewMode === "modules") {
            const g = msg.payload as ModuleGraph;
            const moduleNodes: Node[] = (g.nodes ?? []).map((n) => ({
              id: n.id,
              type: "module",
              position: { x: 0, y: 0 },
              data: {
                label: n.label,
                fileCount: n.file_count,
                estTokens: n.est_tokens,
                title: n.path
              },
              style: { zIndex: 0 }
            }));
            const moduleEdges: Edge[] = (g.edges ?? []).map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              // carry weight through for force distance
              ...(e.weight ? ({ weight: e.weight } as any) : {})
            }));

            setNodes(moduleNodes);
            setEdges(moduleEdges);
            setIsRefreshing(false);
            setStatus("Ready");
            return;
          }

          // Scoped folder expansion: populate node.children instead of adding nodes.
          if (scope) {
            const children = (msg.payload?.nodes ?? []) as any[];
            const uiChildren: UiChild[] = children
              .slice(0, 120)
              .map((c) => {
                const id = String(c?.id ?? "");
                const label = String(c?.label ?? id);
                const kind = nodeKindFromId(id);
                return { id, label, kind, path: id };
              })
              .filter((c) => c.id.length > 0);

            setNodes((prev) =>
              prev.map((n) => {
                if (n.id !== scope.containerId) return n;
                return {
                  ...n,
                  data: {
                    ...(n.data as any),
                    loading: false,
                    expanded: true,
                    children: uiChildren,
                    budgetTokens,
                    onToggle,
                    onInspect: onInspectPath,
                    onExpandFolder: onExpandFolderPath,
                    onSlice: onSlicePath,
                    onOpenAt,
                    onTogglePrivate
                  },
                  style: { ...(n.style as any), zIndex: 1000 }
                };
              })
            );

            setStatus("Ready");
            setIsRefreshing(false);
            return;
          }

          // Default behavior: replace the graph.
          setLastMap(msg.payload);

          // Dagre can fail in some bundling/runtime situations; fall back to grid.
          let graph: { nodes: Node[]; edges: Edge[] };
          try {
            graph = layoutWithDagreDir(msg.payload, layoutDir);
          } catch (e) {
            console.error("[AnvilHolo] dagre layout failed, using fallback grid", e);
            graph = layoutFallbackGrid(msg.payload);
          }

          // Attach callbacks + budget tokens to each node's data.
          setNodes(
            graph.nodes.map((n) => ({
              ...n,
              data: {
                ...(n.data as any),
                budgetTokens,
                onToggle,
                onInspect: onInspectPath,
                onExpandFolder: onExpandFolderPath,
                onSlice: onSlicePath,
                onOpenAt,
                onTogglePrivate
              }
            }))
          );
          setEdges(graph.edges);
          setIsRefreshing(false);
        } catch (e) {
          console.error("[AnvilHolo] UPDATE_GRAPH handler failed", e);
          setStatus(`Render failed: ${String((e as any)?.message || e)}`);
          setIsRefreshing(false);
        }
      }
      if (msg.type === "STATUS") {
        setStatus(msg.text);
        if (msg.text.toLowerCase().includes("mapping")) setIsRefreshing(true);
        if (msg.text.toLowerCase() === "ready") setIsRefreshing(false);
      }
      if (msg.type === "INSPECT_RESULT") {
        // Release dedupe gate.
        const pending = inspectScopeInFlight.current;
        if (pending && pending.targetPath === msg.targetPath) {
          inspectInFlight.current.delete(pending.containerId);
          inspectScopeInFlight.current = null;
        }

        const payload = msg.payload as any;
        const symbols = Array.isArray(payload?.symbols) ? (payload.symbols as UiSymbol[]) : [];
        const exportsList = Array.isArray(payload?.exports) ? (payload.exports as string[]) : [];
        const file = typeof payload?.file === "string" ? payload.file : msg.targetPath;

        setNodes((prev) =>
          prev.map((n) => {
            const matchById = pending?.targetPath === msg.targetPath && n.id === pending.containerId;
            const matchByPath = String((n.data as any)?.path ?? n.id) === msg.targetPath;
            if (!matchById && !matchByPath) return n;

            if (!msg.ok) {
              return {
                ...n,
                data: { ...(n.data as any), loading: false },
                style: { ...(n.style as any), zIndex: 1000 }
              };
            }

            return {
              ...n,
              data: {
                ...(n.data as any),
                kind: "file",
                path: file,
                title: file,
                loading: false,
                expanded: true,
                symbols,
                exports: exportsList,
                showPrivate: false,
                budgetTokens,
                onToggle,
                onInspect: onInspectPath,
                onExpandFolder: onExpandFolderPath,
                onSlice: onSlicePath,
                onOpenAt,
                onTogglePrivate
              } satisfies FileNodeData,
              style: { ...(n.style as any), zIndex: 1000 }
            };
          })
        );

        setStatus(msg.ok ? "Ready" : `Inspect failed: ${msg.error}`);
      }
      if (msg.type === "SLICE_RESULT") {
        if (msg.ok) {
          setSelectedNodeId(msg.target);
          if (typeof msg.estTokens === "number") setSelectedEstTokens(msg.estTokens);
          if (typeof msg.budgetTokens === "number") setBudgetTokens(msg.budgetTokens);
          setStatus(`Slice ready: ${msg.outputPath}`);
        } else {
          setStatus(`Slice failed: ${msg.error}`);
        }
      }
    };

    window.addEventListener("message", onMessage);
    vscode.postMessage({ command: "refreshMap", budgetTokens, mode: "file-tree" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    // Switch data source when view mode changes.
    if (viewMode === "modules") {
      setLastMap(null);
      vscode.postMessage({ command: "refreshMap", budgetTokens, mode: "module-network", targetPath: "." });
    } else {
      vscode.postMessage({ command: "refreshMap", budgetTokens, mode: "file-tree" });
    }
  }, [viewMode, budgetTokens]);

  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    // Re-layout when the layout direction changes.
    if (viewMode === "modules") return;
    if (!lastMap) return;
    try {
      const graph = layoutWithDagreDir(lastMap, layoutDir);
      setNodes(
        graph.nodes.map((n) => ({
          ...n,
          data: {
            ...(n.data as any),
            budgetTokens,
            onToggle,
            onInspect: onInspectPath,
            onExpandFolder: onExpandFolderPath,
            onSlice: onSlicePath,
            onOpenAt
            ,onTogglePrivate
          }
        }))
      );
      setEdges(graph.edges);
    } catch (e) {
      console.error("[AnvilHolo] relayout failed", e);
      const graph = layoutFallbackGrid(lastMap);
      setNodes(
        graph.nodes.map((n) => ({
          ...n,
          data: {
            ...(n.data as any),
            budgetTokens,
            onToggle,
            onInspect: onInspectPath,
            onExpandFolder: onExpandFolderPath,
            onSlice: onSlicePath,
            onOpenAt
            ,onTogglePrivate
          }
        }))
      );
      setEdges(graph.edges);
    }
  }, [layoutDir]);

  useEffect(() => {
    // Ensure we don't end up off-screen after a big update.
    if (!rf) return;
    if (!nodes.length) return;
    const t = window.setTimeout(() => {
      try {
        rf.fitView({ padding: 0.2, duration: 250 });
      } catch {
        // ignore
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [rf, nodes.length]);

  const onNodeClick = (_: any, node: Node) => {
    setSelectedNodeId(node.id);
    const est = (node.data as any)?.estTokens;
    setSelectedEstTokens(typeof est === "number" ? est : null);

    // Keep selection behavior, but let the custom node handle actual actions.
  };

  const onPaneDoubleClick = () => {
    // Single-click is frequently used for panning interactions; double-click is safer.
    vscode.postMessage({ command: "refreshMap", budgetTokens });
  };

  const onManualRefresh = () => {
    setIsRefreshing(true);
    vscode.postMessage({ command: "refreshMap", budgetTokens });
  };

  const onCopyXml = () => {
    if (!selectedNodeId) return;
    vscode.postMessage({ command: "focusNode", target: selectedNodeId, budgetTokens, action: "copy" });
  };

  const onSliceContext = () => {
    if (!selectedNodeId) return;
    vscode.postMessage({ command: "focusNode", target: selectedNodeId, budgetTokens, action: "open" });
  };

  const onToggleLayout = () => {
    setLayoutDir((d) => (d === "LR" ? "TB" : "LR"));
  };

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = search.trim().toLowerCase();
    if (!q) return;
    const match = nodes.find((n) => {
      const label = String((n.data as any)?.label ?? "").toLowerCase();
      return n.id.toLowerCase().includes(q) || label.includes(q);
    });
    if (!match) return;
    setSelectedNodeId(match.id);
    const est = (match.data as any)?.estTokens;
    setSelectedEstTokens(typeof est === "number" ? est : null);

    if (rf) {
      const node = rf.getNode(match.id);
      if (node) {
        rf.fitView({ nodes: [node], padding: 0.35, duration: 400 });
      }
    }
  };

  const fitView = useMemo(() => ({ padding: 0.2 }), []);

  const toolbarButtonStyle: React.CSSProperties = {
    width: 36,
    height: 36,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    border: "1px solid var(--vscode-button-border)",
    background: "var(--vscode-button-background)",
    color: "var(--vscode-button-foreground)",
    cursor: "pointer"
  };

  const toolbarStyle: React.CSSProperties = {
    position: "absolute",
    left: "50%",
    bottom: 14,
    transform: "translateX(-50%)",
    display: "flex",
    gap: 10,
    padding: 10,
    borderRadius: 14,
    background: "var(--vscode-editorWidget-background)",
    border: "1px solid var(--vscode-panel-border)",
    boxShadow: "0 8px 30px rgba(0,0,0,0.25)"
  };

  const modalBackdrop: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  };

  const modalCard: React.CSSProperties = {
    width: 420,
    maxWidth: "92vw",
    borderRadius: 12,
    border: "1px solid var(--vscode-panel-border)",
    background: "var(--vscode-editorWidget-background)",
    padding: 14,
    color: "var(--vscode-foreground)"
  };

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        background: "var(--vscode-editor-background)"
      }}
    >
      {/* On-screen debugger (temporary) */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 10,
          zIndex: 50,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 12,
          color: "#ff3b30",
          background: "rgba(0,0,0,0.35)",
          border: "1px solid rgba(255,59,48,0.45)",
          borderRadius: 8,
          padding: "6px 8px",
          pointerEvents: "none",
          whiteSpace: "pre"
        }}
      >
        {`Window: ${winSize.w} x ${winSize.h}\nNodes: ${nodes.length}\nZoom: ${zoom.toFixed(2)}`}
      </div>

      {/* Search bar (top-left) */}
      <form
        onSubmit={onSearchSubmit}
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderRadius: 10,
          border: "1px solid var(--vscode-panel-border)",
          background: "var(--vscode-editorWidget-background)",
          zIndex: 5
        }}
      >
        <Search size={16} style={{ opacity: 0.8 }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search module…"
          style={{
            width: 220,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--vscode-input-foreground)"
          }}
        />
      </form>

      {/* Canvas */}
      <div style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          onPaneClick={(evt) => {
            console.log("[AnvilHolo] onPaneClick", { detail: (evt as any)?.detail });
            // React Flow v11 does not support onPaneDoubleClick; emulate via click detail.
            if ((evt as any)?.detail === 2) onPaneDoubleClick();
          }}
          onMove={(_evt, viewport) => {
            setZoom(viewport.zoom);
            const now = Date.now();
            if (now - lastMoveLogAt.current > 750) {
              lastMoveLogAt.current = now;
              console.log("[AnvilHolo] onMove", viewport);
            }
          }}
          onInit={setRf}
          style={{ width: "100%", height: "100%" }}
          nodesDraggable={false}
          panOnDrag={true}
          panOnScroll={true}
          zoomOnScroll={true}
          zoomOnPinch={true}
          nodeTypes={{ file: FileNode, directory: FileNode, module: ModuleNode }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {/* Status bar */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "6px 10px",
          fontFamily: "system-ui",
          fontSize: 12,
          borderTop: "1px solid var(--vscode-panel-border)",
          background: "var(--vscode-editorWidget-background)",
          display: "flex",
          gap: 14,
          alignItems: "center",
          justifyContent: "space-between",
          zIndex: 5
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <b>AnvilHolo</b>
          <span style={{ opacity: 0.85 }}>Status: {status}</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center", opacity: 0.9 }}>
          <span>Current Target: {selectedNodeId ?? "(none)"}</span>
          <span>
            Est. Tokens: {selectedEstTokens ?? "—"} / {budgetTokens.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Floating toolbar (bottom center) */}
      <div style={{ ...toolbarStyle, zIndex: 6 }}>
        <button
          onClick={onManualRefresh}
          disabled={isRefreshing}
          style={{ ...toolbarButtonStyle, opacity: isRefreshing ? 0.6 : 1, cursor: isRefreshing ? "default" : "pointer" }}
          title="Refresh map (context-slicer --map)"
        >
          <RotateCw size={18} />
        </button>

        <button
          onClick={onSliceContext}
          disabled={!selectedNodeId}
          style={{ ...toolbarButtonStyle, opacity: selectedNodeId ? 1 : 0.6, cursor: selectedNodeId ? "pointer" : "default" }}
          title="⚡️ Slice Context (generate XML)"
        >
          <Zap size={18} />
        </button>
        <button onClick={() => setSettingsOpen(true)} style={toolbarButtonStyle} title="Settings">
          <Settings size={18} />
        </button>

        <button
          onClick={onToggleView}
          style={toolbarButtonStyle}
          title={viewMode === "files" ? "View: Files" : "View: Modules"}
        >
          <span style={{ fontSize: 12, fontWeight: 800 }}>{viewMode === "files" ? "F" : "M"}</span>
        </button>
        <button
          onClick={onCopyXml}
          style={{ ...toolbarButtonStyle, opacity: selectedNodeId ? 1 : 0.5, cursor: selectedNodeId ? "pointer" : "not-allowed" }}
          disabled={!selectedNodeId}
          title="Copy sliced XML to clipboard"
        >
          <ClipboardCopy size={18} />
        </button>
        <button onClick={onToggleLayout} style={toolbarButtonStyle} title="Toggle layout direction">
          <LayoutGrid size={18} />
        </button>
        <button onClick={() => setHelpOpen(true)} style={toolbarButtonStyle} title="Help / Legend">
          <CircleHelp size={18} />
        </button>
      </div>

      {/* Settings modal */}
      {settingsOpen && (
        <div style={{ ...modalBackdrop, zIndex: 20 }} onClick={() => setSettingsOpen(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <b>Settings</b>
              <button
                onClick={() => setSettingsOpen(false)}
                style={{
                  border: "1px solid var(--vscode-button-border)",
                  background: "transparent",
                  color: "var(--vscode-foreground)",
                  borderRadius: 8,
                  padding: "4px 10px",
                  cursor: "pointer"
                }}
              >
                Close
              </button>
            </div>

            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                Budget Tokens (used for slicing):
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[32000, 64000].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBudgetTokens(v)}
                    style={{
                      border: "1px solid var(--vscode-button-border)",
                      background: v === budgetTokens ? "var(--vscode-button-background)" : "transparent",
                      color: v === budgetTokens ? "var(--vscode-button-foreground)" : "var(--vscode-foreground)",
                      borderRadius: 8,
                      padding: "6px 10px",
                      cursor: "pointer"
                    }}
                  >
                    {v.toLocaleString()}
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="number"
                  value={budgetTokens}
                  onChange={(e) => setBudgetTokens(Number(e.target.value || 0))}
                  style={{
                    width: 160,
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: "1px solid var(--vscode-input-border)",
                    background: "var(--vscode-input-background)",
                    color: "var(--vscode-input-foreground)"
                  }}
                />
                <button
                  onClick={() => {
                    setSettingsOpen(false);
                    onManualRefresh();
                  }}
                  style={{
                    border: "1px solid var(--vscode-button-border)",
                    background: "var(--vscode-button-background)",
                    color: "var(--vscode-button-foreground)",
                    borderRadius: 8,
                    padding: "6px 10px",
                    cursor: "pointer"
                  }}
                >
                  Apply & Scan
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Help overlay */}
      {helpOpen && (
        <div style={{ ...modalBackdrop, zIndex: 20 }} onClick={() => setHelpOpen(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <b>Legend</b>
              <button
                onClick={() => setHelpOpen(false)}
                style={{
                  border: "1px solid var(--vscode-button-border)",
                  background: "transparent",
                  color: "var(--vscode-foreground)",
                  borderRadius: 8,
                  padding: "4px 10px",
                  cursor: "pointer"
                }}
              >
                Close
              </button>
            </div>

            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 12, opacity: 0.95 }}>
              <div>
                <span style={{ display: "inline-block", width: 12, height: 12, background: "#1976d2", borderRadius: 3, marginRight: 8 }} />
                Blue Node: Module (click to slice)
              </div>
              <div>
                <span style={{ display: "inline-block", width: 12, height: 12, background: "#616161", borderRadius: 3, marginRight: 8 }} />
                Grey Node: Group
              </div>
              <div>
                <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #d32f2f", borderRadius: 3, marginRight: 8 }} />
                Red Border: Large module (high estimated size)
              </div>
              <div>Edge: Dependency</div>
              <div>Tip: Click empty canvas to refresh map.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
