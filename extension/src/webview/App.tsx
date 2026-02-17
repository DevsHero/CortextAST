import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, { Background, Controls, Edge, Node, ReactFlowInstance } from "reactflow";
import { MarkerType } from "reactflow";
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
import { NetworkEdge } from "./NetworkEdge";

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
  | { type: "AVAILABLE_MODULES"; modules: Array<{ path: string; type: "npm" | "cargo" | "dart" | "go" }> }
  | { type: "ADD_MODULE"; path: string }
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

  const [availableModules, setAvailableModules] = useState<Array<{ path: string; type: "npm" | "cargo" | "dart" | "go" }>>([]);
  const [selectedModules, setSelectedModules] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  const selectedModulesRef = useRef<string[]>([]);

  const [rf, setRf] = useState<ReactFlowInstance | null>(null);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEstTokens, setSelectedEstTokens] = useState<number | null>(null);

  const [budgetTokens, setBudgetTokens] = useState<number>(32000);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  const [layoutDir, setLayoutDir] = useState<"LR" | "TB">("LR");
  const [lastMap, setLastMap] = useState<RustMap | null>(null);

  const [viewMode, setViewMode] = useState<"files" | "modules">("modules");
  const viewModeRef = useRef(viewMode);

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

  // Telemetry bridge: logs from UI -> Extension Output channel.
  // (The extension logs every webview->ext message as JSON.)
  const logToExt = (msg: string) => {
    try {
      vscode.postMessage({ type: "STATUS", text: `[UI-LOG] ${msg}` });
    } catch {
      // ignore
    }
  };

  // When we force a module-network scan, suppress any stale file-tree refreshes
  // for a short window to prevent race-condition overwrites.
  const suppressFileTreeUntilMs = useRef<number>(0);
  const lastRefreshSig = useRef<{ sig: string; at: number }>({ sig: "", at: 0 });
  const fileTreeAutoRefreshEnabledRef = useRef<boolean>(false);

  const postRefreshMap = (payload: {
    mode: "file-tree" | "module-network";
    manifests?: string[];
    targetPath?: string;
    budgetTokens?: number;
  }) => {
    const now = Date.now();

    // IMPORTANT: if UI is forcing module-network, suppress any file-tree refreshes
    // immediately (even if we end up deduping the module-network send).
    if (payload.mode === "module-network") {
      suppressFileTreeUntilMs.current = Math.max(suppressFileTreeUntilMs.current, now + 1000);
    }

    const sig = JSON.stringify({
      mode: payload.mode,
      manifests: payload.manifests ?? [],
      targetPath: payload.targetPath ?? "",
      budgetTokens: payload.budgetTokens ?? null
    });

    // Deduplicate rapid duplicate sends (effects + handlers can overlap).
    if (lastRefreshSig.current.sig === sig && now - lastRefreshSig.current.at < 250) {
      logToExt(`Skipping duplicate refreshMap (${payload.mode})`);
      return;
    }
    lastRefreshSig.current = { sig, at: now };

    if (payload.mode === "file-tree" && now < suppressFileTreeUntilMs.current) {
      logToExt("Suppressed stale file-tree refreshMap (recent forced module-network)");
      return;
    }

    logToExt(
      `Sending refreshMap mode=${payload.mode}` +
        (payload.manifests?.length ? ` manifests=${payload.manifests.join(",")}` : "") +
        (payload.targetPath ? ` target=${payload.targetPath}` : "")
    );
    vscode.postMessage({
      command: "refreshMap",
      mode: payload.mode,
      manifests: payload.manifests,
      targetPath: payload.targetPath,
      budgetTokens: payload.budgetTokens
    });
  };

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

    postRefreshMap({ mode: "file-tree", budgetTokens, targetPath });
  };

  const onToggleView = () => {
    const next = viewModeRef.current === "files" ? "modules" : "files";
    viewModeRef.current = next;
    setViewMode(next);

    if (next === "files") {
      // Only after an explicit user action do we allow auto-refreshing file-tree.
      fileTreeAutoRefreshEnabledRef.current = true;
      logToExt("Manual switch to File Tree View");
      setIsRefreshing(true);
      setStatus("Mapping workspace...");
      postRefreshMap({ mode: "file-tree", budgetTokens });
      return;
    }

    // Safety net: when the user manually switches to module view, make sure we
    // actually request the manifest-driven scan (and include the manifests list).
    if (next === "modules") {
      const manifests = selectedModulesRef.current;
      if (manifests.length) {
        logToExt("Manual switch to Network View; forcing manifest scan");
        setIsRefreshing(true);
        setStatus("Mapping selected modules...");
        postRefreshMap({ mode: "module-network", manifests, budgetTokens });
      }
    }
  };

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    selectedModulesRef.current = selectedModules;
  }, [selectedModules]);

  const refreshSelectedModules = (manifests: string[], opts?: { force?: boolean }) => {
    const uniq = Array.from(new Set((manifests || []).map((p) => String(p || "").trim()).filter(Boolean)));
    setSelectedModules(uniq);

    // REAL FIX: do not rely on async React state for mode switching.
    // If manifests are selected, force Modules view immediately and dispatch with explicit mode.
    if (uniq.length) {
      logToExt("refreshSelectedModules: forcing NETWORK mode dispatch");
      viewModeRef.current = "modules";
      setViewMode("modules");
      setSidebarCollapsed(false);
    }

    const canRun = opts?.force || viewModeRef.current === "modules";
    if (!canRun) return;
    if (!uniq.length) {
      setNodes([]);
      setEdges([]);
      setLastMap(null);
      setIsRefreshing(false);
      setStatus("Ready");
      return;
    }

    setIsRefreshing(true);
    setStatus("Mapping selected modules...");
    postRefreshMap({ mode: "module-network", manifests: uniq, budgetTokens });
  };

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
    setLastMap(null);
    setSelectedNodeId(null);
    setSelectedEstTokens(null);
    setSelectedModules([]);
    setIsRefreshing(false);
    setStatus("Ready");
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
      if (msg.type === "AVAILABLE_MODULES") {
        setAvailableModules(Array.isArray((msg as any).modules) ? (msg as any).modules : []);
        setStatus("Ready");
        return;
      }
      if (msg.type === "ADD_MODULE") {
        const p = String((msg as any).path || "").trim().replace(/\\/g, "/");
        if (!p) return;

        // Prime suppression immediately to prevent any stale file-tree refresh
        // from firing during the same tick.
        suppressFileTreeUntilMs.current = Math.max(suppressFileTreeUntilMs.current, Date.now() + 1000);

        const lower = p.toLowerCase();
        const guessType = lower.endsWith("/cargo.toml")
          ? "cargo"
          : lower.endsWith("/pubspec.yaml")
            ? "dart"
            : lower.endsWith("/go.mod")
              ? "go"
              : "npm";

        setAvailableModules((prev) => {
          if (prev.some((m) => m.path === p)) return prev;
          return [...prev, { path: p, type: guessType }].sort((a, b) => a.path.localeCompare(b.path));
        });

        // CRITICAL: This must immediately switch the UI to module view AND
        // immediately request a manifest-driven scan with the full list.
        logToExt(`Adding module ${p}, forcing switch to NETWORK mode`);
        viewModeRef.current = "modules";
        setViewMode("modules");
        setSidebarCollapsed(false);

        const updatedSet = new Set<string>(selectedModulesRef.current);
        updatedSet.add(p);
        const manifests = Array.from(updatedSet);

        // Keep state/ref in sync immediately to avoid races with viewModeRef in UPDATE_GRAPH.
        selectedModulesRef.current = manifests;
        setSelectedModules(manifests);

        setIsRefreshing(true);
        setStatus("Mapping selected modules...");
        postRefreshMap({ mode: "module-network", manifests, budgetTokens });
        return;
      }
      if (msg.type === "UPDATE_GRAPH") {
        try {
          console.log("[AnvilHolo] UPDATE_GRAPH", {
            nodes: msg.payload?.nodes?.length,
            edges: msg.payload?.edges?.length
          });

          // Data guard: if we receive a module graph payload while the UI is in file view,
          // auto-switch so the data is rendered correctly.
          const looksLikeModuleGraph =
            Array.isArray((msg.payload as any)?.nodes) &&
            // IMPORTANT: file-tree nodes also have bytes/est_tokens.
            // ModuleGraph is uniquely identified by `file_count`.
            (msg.payload as any).nodes.some((n: any) => typeof n?.file_count === "number");
          if (looksLikeModuleGraph && viewModeRef.current !== "modules") {
            console.log("[AnvilHolo] Auto-switching to Network View based on payload shape");
            viewModeRef.current = "modules";
            setViewMode("modules");
            setSidebarCollapsed(false);
          }
          const scope = mapScopeInFlight.current;
          mapScopeInFlight.current = null;

          // Module network view: replace nodes/edges and let force layout place them.
          if (viewModeRef.current === "modules" || looksLikeModuleGraph) {
            const g = msg.payload as ModuleGraph;

            const statsById = new Map<string, { inCount: number; outCount: number; inWeight: number; outWeight: number }>();
            for (const n of g.nodes ?? []) {
              statsById.set(n.id, { inCount: 0, outCount: 0, inWeight: 0, outWeight: 0 });
            }
            for (const e of g.edges ?? []) {
              const w = typeof e.weight === "number" ? e.weight : 1;
              const s = statsById.get(e.source);
              if (s) {
                s.outCount += 1;
                s.outWeight += w;
              }
              const t = statsById.get(e.target);
              if (t) {
                t.inCount += 1;
                t.inWeight += w;
              }
            }

            const minSize = 60;
            const maxSize = 150;
            const sizes = (g.nodes ?? []).map((n) => Math.max(1, n.est_tokens ?? 1));
            const maxTok = sizes.length ? Math.max(...sizes) : 1;

            const moduleNodes: Node[] = (g.nodes ?? []).map((n, idx) => ({
              id: n.id,
              type: "moduleNode",
              // IMPORTANT: seed non-overlapping positions.
              // With 0 edges, force layout can leave nodes stacked at the same coordinate.
              position: {
                x: (g.nodes?.length ?? 0) <= 1 ? 0 : (idx % 4) * 320,
                y: (g.nodes?.length ?? 0) <= 1 ? 0 : Math.floor(idx / 4) * 260
              },
              data: {
                label: n.label,
                fileCount: n.file_count,
                estTokens: n.est_tokens,
                inCount: statsById.get(n.id)?.inCount ?? 0,
                outCount: statsById.get(n.id)?.outCount ?? 0,
                inWeight: statsById.get(n.id)?.inWeight ?? 0,
                outWeight: statsById.get(n.id)?.outWeight ?? 0,
                path: n.path,
                expanded: false,
                loading: false,
                exports: [],
                details: [],
                resolvedTarget: undefined,
                onOpenAt,
                title: n.path,
                // size scaling by token count (sqrt dampening)
                sizePx: Math.floor(
                  minSize + (Math.sqrt(Math.max(1, n.est_tokens)) / Math.sqrt(maxTok)) * (maxSize - minSize)
                )
              },
              style: { zIndex: 0 }
            }));
            const moduleEdges: Edge[] = (g.edges ?? []).map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              type: "network",
              markerEnd: { type: MarkerType.ArrowClosed },
              data: { weight: e.weight }
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

        // Module drill-down: if targetPath matches a module node, attach exports/symbols to that node.
        const updatedModule = nodes.some(
          (n) => n.type === "moduleNode" && (((n.data as any)?.path ?? n.id) === msg.targetPath || n.id === msg.targetPath)
        );
        if (updatedModule) {
          setNodes((prev) =>
            prev.map((n) => {
              if (n.type !== "moduleNode") return n;
              const modulePath = String((n.data as any)?.path ?? n.id);
              if (modulePath !== msg.targetPath && n.id !== msg.targetPath) return n;

              return {
                ...n,
                data: {
                  ...(n.data as any),
                  loading: false,
                  expanded: true,
                  exports: exportsList,
                  details: symbols,
                  resolvedTarget: payload?.resolvedTarget ?? file
                }
              };
            })
          );
          setStatus(msg.ok ? "Ready" : `Inspect failed: ${msg.error}`);
          return;
        }

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
    setStatus("Discovering modules...");
    vscode.postMessage({ command: "webviewReady" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    // Switch data source when view mode changes.
    if (viewMode === "modules") {
      setLastMap(null);
      // Native manager: graph is driven by checkbox-selected manifests.
      if (selectedModules.length) {
        refreshSelectedModules(selectedModules);
      } else {
        setNodes([]);
        setEdges([]);
      }
    } else {
      // IMPORTANT: do not auto-refresh file-tree on startup.
      // Only refresh file-tree if the user explicitly switched to File Tree View.
      if (fileTreeAutoRefreshEnabledRef.current) {
        postRefreshMap({ mode: "file-tree", budgetTokens });
      } else {
        logToExt("File Tree auto-refresh skipped (not explicitly enabled)");
      }
    }
  }, [viewMode, budgetTokens]);

  useEffect(() => {
    // Data guard (post-processing): if module-shaped data ended up in the file-tree map state,
    // switch back to module view so the UI can't get stuck showing the wrong mode.
    const nodesAny = (lastMap as any)?.nodes;
    const looksLikeModuleGraph = Array.isArray(nodesAny) && nodesAny.some((n: any) => typeof n?.file_count === "number");
    if (viewMode === "files" && looksLikeModuleGraph) {
      console.log("[AnvilHolo] Auto-switching to Network View based on lastMap shape");
      viewModeRef.current = "modules";
      setViewMode("modules");
      setSidebarCollapsed(false);
    }
  }, [lastMap, viewMode]);

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

    // Module drill-down: inspect entry file for the module (resolved by extension host).
    if (node.type === "moduleNode") {
      const modulePath = String((node.data as any)?.path ?? node.id);
      logToExt(`Inspecting module: ${modulePath}`);
      setStatus(`Inspecting module: ${modulePath}`);
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== node.id) return n;
          return {
            ...n,
            data: {
              ...(n.data as any),
              loading: true,
              expanded: true,
              exports: (n.data as any)?.exports ?? [],
              details: (n.data as any)?.details ?? []
            }
          };
        })
      );
      vscode.postMessage({ command: "inspectNode", targetPath: modulePath });
    }

    // Make module-network selection visible/actionable.
    if (viewModeRef.current === "modules" || node.type === "moduleNode") {
      const fileCount = (node.data as any)?.fileCount;
      const inCount = (node.data as any)?.inCount;
      const outCount = (node.data as any)?.outCount;
      const inWeight = (node.data as any)?.inWeight;
      const outWeight = (node.data as any)?.outWeight;

      const msg =
        `Selected module: ${node.id}` +
        (typeof fileCount === "number" ? ` (${fileCount} files)` : "") +
        (typeof est === "number" ? ` (${Math.round(est).toLocaleString()} tok)` : "") +
        (typeof inCount === "number" || typeof outCount === "number"
          ? ` | in=${Number(inCount || 0)}(${Number(inWeight || 0)}) out=${Number(outCount || 0)}(${Number(outWeight || 0)})`
          : "");

      setStatus(msg);
      logToExt(msg);
    }

    // Keep selection behavior, but let the custom node handle actual actions.
  };

  const onNodeDoubleClick = (_: any, node: Node) => {
    if (node.type !== "moduleNode" && viewModeRef.current !== "modules") return;
    logToExt(`Double-click slice/open: ${node.id}`);
    vscode.postMessage({ command: "focusNode", target: node.id, budgetTokens, action: "open" });
  };

  const onPaneDoubleClick = () => {
    // Single-click is frequently used for panning interactions; double-click is safer.
    if (viewModeRef.current === "modules") {
      if (selectedModules.length) refreshSelectedModules(selectedModules);
      return;
    }
    postRefreshMap({ mode: "file-tree", budgetTokens });
  };

  const onManualRefresh = () => {
    setIsRefreshing(true);
    if (viewModeRef.current === "modules") {
      refreshSelectedModules(selectedModules);
      return;
    }
    postRefreshMap({ mode: "file-tree", budgetTokens });
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

  const showModuleHint = viewMode === "modules" && selectedModules.length === 0 && nodes.length === 0;
  const showEmptyGraphError = viewMode === "modules" && selectedModules.length > 0 && nodes.length === 0 && !isRefreshing;

  const sidebarWidth = 320;
  const sidebarOpenWidth = sidebarCollapsed ? 0 : sidebarWidth;

  const panelButtonStyle: React.CSSProperties = {
    border: "1px solid var(--vscode-button-border)",
    background: "transparent",
    color: "var(--vscode-foreground)",
    borderRadius: 8,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 12
  };

  const sidebarButtonStyle: React.CSSProperties = {
    border: "1px solid var(--vscode-button-border)",
    background: "var(--vscode-button-background)",
    color: "var(--vscode-button-foreground)",
    borderRadius: 8,
    padding: "6px 10px",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 12
  };

  const displayNameForManifest = (p: string) => {
    const normalized = String(p || "").replace(/\\/g, "/");
    return normalized.replace(/\/(package\.json|Cargo\.toml|pubspec\.yaml|go\.mod)$/i, "");
  };

  const selectedModulePanel = useMemo(() => {
    if (viewMode !== "modules") return null;
    if (!selectedNodeId) return null;
    const node = nodes.find((n) => n.id === selectedNodeId && n.type === "moduleNode");
    if (!node) return null;

    const fileCount = (node.data as any)?.fileCount;
    const estTokens = (node.data as any)?.estTokens;
    const inCount = (node.data as any)?.inCount ?? 0;
    const outCount = (node.data as any)?.outCount ?? 0;
    const inWeight = (node.data as any)?.inWeight ?? 0;
    const outWeight = (node.data as any)?.outWeight ?? 0;

    const outbound = edges
      .filter((e) => e.source === node.id)
      .map((e) => ({ id: e.target, w: Number((e.data as any)?.weight ?? 1) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 8);
    const inbound = edges
      .filter((e) => e.target === node.id)
      .map((e) => ({ id: e.source, w: Number((e.data as any)?.weight ?? 1) }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 8);

    return {
      id: node.id,
      label: String((node.data as any)?.label ?? node.id),
      fileCount: typeof fileCount === "number" ? fileCount : undefined,
      estTokens: typeof estTokens === "number" ? estTokens : undefined,
      inCount,
      outCount,
      inWeight,
      outWeight,
      inbound,
      outbound
    };
  }, [viewMode, selectedNodeId, nodes, edges]);

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
      <style>{`
        @keyframes anvilSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {/* Sidebar (Module Manager) */}
      {!sidebarCollapsed && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: sidebarOpenWidth,
            borderRight: "1px solid var(--vscode-panel-border)",
            background: "var(--vscode-sideBar-background)",
            color: "var(--vscode-foreground)",
            zIndex: 9,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
          }}
        >
          <div style={{ padding: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <b>Available Modules</b>
            <button onClick={() => setSidebarCollapsed(true)} style={panelButtonStyle} title="Collapse sidebar">
              Hide
            </button>
          </div>

          <div style={{ padding: "0 10px 10px", display: "flex", gap: 8 }}>
            <button
              style={{ ...sidebarButtonStyle, opacity: availableModules.length ? 1 : 0.5 }}
              onClick={() => refreshSelectedModules(availableModules.map((m) => m.path))}
              disabled={!availableModules.length}
              title="Select all discovered modules"
            >
              Select All
            </button>
            <button
              style={{ ...sidebarButtonStyle, opacity: selectedModules.length ? 1 : 0.5 }}
              onClick={() => refreshSelectedModules([])}
              disabled={!selectedModules.length}
              title="Clear selection"
            >
              Clear All
            </button>
          </div>

          <div style={{ padding: "0 10px 10px", fontSize: 12, opacity: 0.9 }}>
            {availableModules.length ? `${availableModules.length} detected` : "No manifests detected"}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 12px" }}>
            {availableModules.map((m) => {
              const checked = selectedModules.includes(m.path);
              const label = displayNameForManifest(m.path) || m.path;
              return (
                <label
                  key={m.path}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    padding: "6px 4px",
                    borderRadius: 8,
                    cursor: "pointer"
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selectedModules, m.path]
                        : selectedModules.filter((p) => p !== m.path);
                      refreshSelectedModules(next);
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: 800, fontSize: 12 }}>{label}</span>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>
                      {m.type} • {m.path}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {sidebarCollapsed && (
        <div style={{ position: "absolute", left: 10, top: 10, zIndex: 9 }}>
          <button onClick={() => setSidebarCollapsed(false)} style={panelButtonStyle} title="Show sidebar">
            Show Modules
          </button>
        </div>
      )}

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
          left: sidebarOpenWidth ? sidebarOpenWidth + 10 : 10,
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
      <div
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={(evt, node) => {
            onNodeClick(evt, node);
            // React Flow v11 does not support onNodeDoubleClick; emulate via click detail.
            if ((evt as any)?.detail === 2) onNodeDoubleClick(evt, node);
          }}
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
          nodeTypes={{ file: FileNode, directory: FileNode, moduleNode: ModuleNode }}
          edgeTypes={{ network: NetworkEdge }}
        >
          <Background />
          <Controls />
        </ReactFlow>

        {selectedModulePanel && (
          <div
            style={{
              position: "absolute",
              left: sidebarOpenWidth ? sidebarOpenWidth + 14 : 14,
              top: 58,
              zIndex: 6,
              maxWidth: 460,
              borderRadius: 12,
              border: "1px solid var(--vscode-panel-border)",
              background: "var(--vscode-editorWidget-background)",
              color: "var(--vscode-foreground)",
              padding: "10px 12px"
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>
              Selected: {selectedModulePanel.label}
            </div>
            <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>
              {typeof selectedModulePanel.fileCount === "number" ? `${selectedModulePanel.fileCount} files` : ""}
              {typeof selectedModulePanel.estTokens === "number"
                ? ` • ${Math.round(selectedModulePanel.estTokens).toLocaleString()} tok`
                : ""}
              {` • in=${selectedModulePanel.inCount}(${selectedModulePanel.inWeight}) out=${selectedModulePanel.outCount}(${selectedModulePanel.outWeight})`}
            </div>

            {selectedModulePanel.inCount + selectedModulePanel.outCount === 0 ? (
              <div style={{ fontSize: 11, opacity: 0.8 }}>
                No connections detected between selected modules (edges=0).
              </div>
            ) : (
              <div style={{ display: "flex", gap: 12, fontSize: 11, opacity: 0.9 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>Outbound</div>
                  {selectedModulePanel.outbound.map((x) => (
                    <div key={x.id} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{x.id}</span>
                      <span style={{ opacity: 0.8 }}>{x.w}</span>
                    </div>
                  ))}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>Inbound</div>
                  {selectedModulePanel.inbound.map((x) => (
                    <div key={x.id} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{x.id}</span>
                      <span style={{ opacity: 0.8 }}>{x.w}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {showModuleHint && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 4
            }}
          >
            <div
              style={{
                padding: "18px 22px",
                borderRadius: 12,
                border: "1px dashed var(--vscode-panel-border)",
                background: "var(--vscode-editorWidget-background)",
                color: "var(--vscode-foreground)",
                opacity: 0.92,
                fontWeight: 700
              }}
            >
              No modules selected. Select checkboxes in the sidebar to build the graph.
            </div>
          </div>
        )}

        {showEmptyGraphError && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 4
            }}
          >
            <div
              style={{
                padding: "22px 28px",
                borderRadius: 12,
                border: "2px solid var(--vscode-errorForeground)",
                background: "var(--vscode-editorWidget-background)",
                color: "var(--vscode-foreground)",
                opacity: 0.95,
                maxWidth: "600px",
                textAlign: "center"
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 12, color: "var(--vscode-errorForeground)" }}>
                ⚠️ No Modules Found
              </div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                Scanned manifests: {selectedModules.map(displayNameForManifest).join(", ")}
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                Check the <strong>Output Channel</strong> (View → Output → "AnvilHolo") for Rust debug logs.
              </div>
            </div>
          </div>
        )}

        {isRefreshing && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              zIndex: 5
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  border: "2px solid var(--vscode-panel-border)",
                  borderTopColor: "var(--vscode-progressBar-background)",
                  animation: "anvilSpin 0.9s linear infinite"
                }}
              />
              <div style={{ color: "var(--vscode-foreground)", fontWeight: 700 }}>Loading…</div>
            </div>
          </div>
        )}
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
          onClick={clearCanvas}
          style={toolbarButtonStyle}
          title="Clear canvas"
        >
          <span style={{ fontSize: 12, fontWeight: 800 }}>Clear</span>
        </button>
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
          title={viewMode === "files" ? "Switch to System Network" : "Switch to File Tree"}
        >
          <span style={{ fontSize: 12, fontWeight: 800 }}>
            {viewMode === "files" ? "🕸️ System Network" : "📂 File Tree"}
          </span>
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
