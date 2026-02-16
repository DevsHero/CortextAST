import React from "react";
import type { NodeProps } from "reactflow";
import { FileText, Folder, ChevronDown, ChevronRight, Zap } from "lucide-react";

export type UiSymbol = {
  name: string;
  kind: string;
  line: number;
  line_end: number;
  signature?: string | null;
};

export type UiChild = {
  id: string;
  label: string;
  kind: "file" | "directory";
  path: string;
};

export type FileNodeData = {
  kind: "file" | "directory";
  label: string;
  path: string;
  title?: string;

  expanded?: boolean;
  loading?: boolean;

  symbols?: UiSymbol[];
  exports?: string[];
  showPrivate?: boolean;
  children?: UiChild[];

  budgetTokens?: number;

  onToggle?: (containerId: string) => void;
  onInspect?: (containerId: string, targetPath: string) => void;
  onExpandFolder?: (containerId: string, targetPath: string) => void;
  onSlice?: (path: string) => void;
  onOpenAt?: (file: string, line: number) => void;
  onTogglePrivate?: (containerId: string) => void;
};

function kindIcon(kind: string): string {
  if (kind === "function" || kind === "method") return "𝑓";
  if (kind === "class") return "📦";
  if (kind === "struct") return "🏗";
  return "•";
}

export function FileNode({ id, data, selected }: NodeProps<FileNodeData>) {
  const expanded = Boolean(data.expanded);
  const loading = Boolean(data.loading);

  const isDir = data.kind === "directory";
  const Icon = isDir ? Folder : FileText;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  const baseBg = "var(--vscode-editorWidget-background)";
  const baseBorder = "1px solid var(--vscode-panel-border)";
  const baseFg = "var(--vscode-foreground)";

  const shadow = expanded ? "0 10px 30px rgba(0,0,0,0.50)" : "0 1px 0 rgba(0,0,0,0.10)";

  return (
    <div
      title={data.title ?? data.path}
      style={{
        width: 280,
        color: baseFg,
        background: baseBg,
        border: baseBorder,
        borderRadius: 8,
        boxShadow: shadow,
        overflow: "hidden",
        pointerEvents: "auto",
        outline: selected ? "1px solid var(--vscode-focusBorder)" : "none"
      }}
    >
      {/* Header */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (expanded) {
            data.onToggle?.(id);
            return;
          }
          if (isDir) {
            data.onExpandFolder?.(id, data.path);
          } else {
            data.onInspect?.(id, data.path);
          }
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 10px",
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer"
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Icon size={16} style={{ opacity: 0.9, flex: "0 0 auto" }} />
          <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {data.label}
          </span>
        </span>
        <Chevron size={16} style={{ opacity: 0.85, flex: "0 0 auto" }} />
      </button>

      {/* Body */}
      {expanded ? (
        <div style={{ borderTop: "1px solid var(--vscode-panel-border)", padding: 10 }}>
          {loading ? (
            <div style={{ fontSize: 12, opacity: 0.85 }}>Loading…</div>
          ) : isDir ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(data.children ?? []).length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto" }}>
                  {(data.children ?? []).slice(0, 60).map((c) => (
                    <button
                      key={c.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (c.kind === "directory") data.onExpandFolder?.(id, c.path);
                        else data.onInspect?.(id, c.path);
                      }}
                      style={{
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        opacity: 0.95
                      }}
                      title={c.path}
                    >
                      <span style={{ opacity: 0.9 }}>{c.kind === "directory" ? "📁" : "📄"}</span>
                      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.label}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.8 }}>(empty)</div>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Smart filter */}
              {(data.exports ?? []).length ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onTogglePrivate?.(id);
                  }}
                  style={{
                    alignSelf: "flex-start",
                    background: "transparent",
                    border: "none",
                    color: "var(--vscode-textLink-foreground)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 12
                  }}
                  title="Toggle exported-only vs show all symbols"
                >
                  {data.showPrivate ? "Show Exports Only" : "Show Private"}
                </button>
              ) : null}

              {(data.symbols ?? []).length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflow: "auto" }}>
                  {(data.symbols ?? [])
                    .filter((s) => {
                      const exports = data.exports ?? [];
                      if (!exports.length) return true;
                      if (data.showPrivate) return true;
                      return exports.includes(s.name);
                    })
                    .slice(0, 60)
                    .map((s, idx) => (
                    <button
                      key={`${s.kind}:${s.name}:${idx}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        data.onOpenAt?.(data.path, s.line);
                      }}
                      style={{
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        opacity: 0.95
                      }}
                      title={s.signature ?? `${s.kind} ${s.name}`}
                    >
                      <span style={{ opacity: 0.9 }}>{kindIcon(s.kind)}</span>
                      <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.name}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, opacity: 0.8 }}>(no symbols)</div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Footer */}
      {!isDir ? (
        <div
          style={{
            borderTop: expanded ? "1px solid var(--vscode-panel-border)" : "none",
            padding: expanded ? 10 : 0,
            display: expanded ? "flex" : "none",
            justifyContent: "flex-end"
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              data.onSlice?.(data.path);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--vscode-button-border)",
              background: "var(--vscode-button-background)",
              color: "var(--vscode-button-foreground)",
              cursor: "pointer"
            }}
            title="⚡️ Slice Context"
          >
            <Zap size={16} />
            <span style={{ fontSize: 12, fontWeight: 600 }}>Slice Context</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
