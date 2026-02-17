import React from "react";
import { Handle, Position, type NodeProps } from "reactflow";

export type ModuleNodeData = {
  label: string;
  fileCount: number;
  estTokens: number;
  inCount?: number;
  outCount?: number;
  inWeight?: number;
  outWeight?: number;
  path?: string;
  expanded?: boolean;
  loading?: boolean;
  exports?: string[];
  details?: Array<{ name: string; kind: string; line: number; line_end: number; signature?: string | null }>;
  resolvedTarget?: string;
  onOpenAt?: (file: string, line: number) => void;
  sizePx?: number;
  layer?: string;
  title?: string;
};

function layerFromId(idOrPath: string): string {
  const s = idOrPath.toLowerCase();
  if (s.includes("core") || s.startsWith("core/")) return "core";
  if (s.includes("ui") || s.includes("webview") || s.includes("components")) return "ui";
  if (s.includes("utils") || s.includes("shared") || s.includes("common")) return "utils";
  return "app";
}

function layerBorderColor(layer: string): string {
  // Prefer VS Code theme chart colors (no hard-coded palette).
  switch (layer) {
    case "core":
      return "var(--vscode-charts-orange)";
    case "ui":
      return "var(--vscode-charts-blue)";
    case "utils":
      return "var(--vscode-charts-gray)";
    default:
      return "var(--vscode-charts-green)";
  }
}

export function ModuleNode({ data, selected }: NodeProps<ModuleNodeData>) {
  const size = Math.max(60, Math.min(150, Math.floor(data.sizePx ?? 120)));
  const layer = data.layer ?? layerFromId(data.title ?? data.label);
  const borderColor = layerBorderColor(layer);

  const inCount = typeof data.inCount === "number" ? data.inCount : 0;
  const outCount = typeof data.outCount === "number" ? data.outCount : 0;
  const inWeight = typeof data.inWeight === "number" ? data.inWeight : 0;
  const outWeight = typeof data.outWeight === "number" ? data.outWeight : 0;

  const exportsList = Array.isArray(data.exports) ? data.exports : [];
  const details = Array.isArray(data.details) ? data.details : [];
  const resolvedFile = typeof data.resolvedTarget === "string" ? data.resolvedTarget : undefined;
  const expanded = Boolean(data.expanded);
  const loading = Boolean(data.loading);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        title={data.title ?? data.label}
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          background: "var(--vscode-editorWidget-background)",
          border: selected ? "2px solid var(--vscode-focusBorder)" : `2px solid ${borderColor}`,
          color: "var(--vscode-foreground)",
          boxShadow: "0 12px 34px rgba(0,0,0,0.45)",
          textAlign: "center",
          padding: 10
        }}
      >
      {/* Invisible handles so edges can connect from any side */}
      <Handle type="source" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Bottom} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Right} style={{ opacity: 0 }} />

      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
        {data.label}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{data.fileCount} files</div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>{data.estTokens.toLocaleString()} tok</div>

        {selected && (
          <div style={{ fontSize: 10, opacity: 0.75 }}>
            in: {inCount} ({inWeight}) • out: {outCount} ({outWeight})
          </div>
        )}
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 10,
            width: 340,
            borderRadius: 12,
            border: "1px solid var(--vscode-panel-border)",
            background: "rgba(0,0,0,0.35)",
            color: "var(--vscode-foreground)",
            padding: 10,
            boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
            backdropFilter: "blur(6px)",
            pointerEvents: "auto"
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 12, marginBottom: 6 }}>
            HUD • {data.label}
          </div>

          {loading && <div style={{ fontSize: 11, opacity: 0.8 }}>Inspecting…</div>}

          {!loading && resolvedFile && (
            <div style={{ fontSize: 10, opacity: 0.7, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis" }}>
              source: {resolvedFile}
            </div>
          )}

          {!loading && exportsList.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 800, fontSize: 11, marginBottom: 6 }}>Public API</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {exportsList.slice(0, 12).map((x) => (
                  <div key={x} style={{ fontSize: 11, opacity: 0.9, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {x}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && details.length > 0 && (
            <div>
              <div style={{ fontWeight: 800, fontSize: 11, marginBottom: 6 }}>Symbols</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                {details.slice(0, 25).map((s) => (
                  <div key={`${s.kind}:${s.name}:${s.line}`} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {s.name}
                      </div>
                      <div style={{ fontSize: 10, opacity: 0.7 }}>{s.kind} • line {s.line}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!data.onOpenAt) return;
                        const file = resolvedFile ?? "";
                        if (!file) return;
                        data.onOpenAt(file, s.line);
                      }}
                      style={{
                        border: "1px solid var(--vscode-button-border)",
                        background: "var(--vscode-button-background)",
                        color: "var(--vscode-button-foreground)",
                        borderRadius: 8,
                        padding: "4px 8px",
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: data.onOpenAt && resolvedFile ? "pointer" : "not-allowed",
                        opacity: data.onOpenAt && resolvedFile ? 1 : 0.5
                      }}
                      disabled={!data.onOpenAt || !resolvedFile}
                      title="Jump to symbol"
                    >
                      Jump
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && exportsList.length === 0 && details.length === 0 && (
            <div style={{ fontSize: 11, opacity: 0.8 }}>No symbol data available for this module.</div>
          )}
        </div>
      )}
    </div>
  );
}
