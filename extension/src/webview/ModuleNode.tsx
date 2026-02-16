import React from "react";
import type { NodeProps } from "reactflow";

export type ModuleNodeData = {
  label: string;
  fileCount: number;
  estTokens: number;
  title?: string;
};

export function ModuleNode({ data, selected }: NodeProps<ModuleNodeData>) {
  return (
    <div
      title={data.title ?? data.label}
      style={{
        width: 140,
        height: 140,
        borderRadius: 999,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: "var(--vscode-editorWidget-background)",
        border: selected ? "2px solid var(--vscode-focusBorder)" : "1px solid var(--vscode-panel-border)",
        color: "var(--vscode-foreground)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        textAlign: "center",
        padding: 10
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
        {data.label}
      </div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{data.fileCount} files</div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>{data.estTokens.toLocaleString()} tok</div>
    </div>
  );
}
