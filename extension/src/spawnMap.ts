import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RepoMap = {
  nodes: Array<{ id: string; label: string; path: string; size_class: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
};

export type ModuleGraph = {
  nodes: Array<{ id: string; label: string; path: string; file_count: number; bytes: number; est_tokens: number }>;
  edges: Array<{ id: string; source: string; target: string; weight: number }>;
};

export type MapMode = "file-tree" | "module-network";

function slicerBinName(): string {
  return process.platform === "win32" ? "context-slicer.exe" : "context-slicer";
}

export function findSlicerBinary(workspaceRoot: string, extensionRoot: string): string {
  const binName = slicerBinName();

  const envBin = process.env.CONTEXT_SLICER_BIN;
  if (typeof envBin === "string" && envBin.length) {
    if (existsSync(envBin)) return envBin;
    return envBin;
  }

  const candidates = [
    // Dev: repo layout
    join(workspaceRoot, "core", "target", "release", binName),
    // Prod: bundled alongside the extension
    join(extensionRoot, "bin", binName)
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Last resort: PATH
  return binName;
}

export async function spawnSlicerMap(
  extensionUri: vscode.Uri,
  outputChannel?: vscode.OutputChannel,
  targetPath?: string
  ,
  mode: MapMode = "file-tree"
): Promise<RepoMap | ModuleGraph> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");

  const workspaceRoot = folder.uri.fsPath;
  const extensionRoot = extensionUri.fsPath;
  const bin = findSlicerBinary(workspaceRoot, extensionRoot);

  const args = (mode === "module-network" ? ["--graph-modules"] : ["--map"]) as string[];
  if (typeof targetPath === "string" && targetPath.length) {
    args.push(targetPath);
  }

  if (outputChannel) {
    outputChannel.appendLine(`[spawnSlicerMap] bin=${bin}`);
    outputChannel.appendLine(`[spawnSlicerMap] cwd=${workspaceRoot}`);
    outputChannel.appendLine(`[spawnSlicerMap] cmd: ${bin} ${args.join(" ")}`);
  }

  const jsonText = await new Promise<string>((resolve, reject) => {
    const cp = spawn(bin, args, { cwd: workspaceRoot });

    let stdout = "";
    let stderr = "";

    const timeoutMs = 8000;
    const timeout = setTimeout(() => {
      try {
        cp.kill();
      } catch {
        // ignore
      }
      const sub = mode === "module-network" ? "--graph-modules" : "--map";
      reject(new Error(`context-slicer ${sub} timed out after ${timeoutMs}ms (bin=${bin}, cwd=${workspaceRoot})`));
    }, timeoutMs);

    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");

    cp.stdout.on("data", (d) => (stdout += d));
    cp.stderr.on("data", (d) => {
      stderr += d;
      if (outputChannel) {
        outputChannel.appendLine(`[spawnSlicerMap] stderr: ${d}`);
      }
    });

    cp.on("error", (err) => {
      if (outputChannel) {
        outputChannel.appendLine(`[spawnSlicerMap] spawn error: ${err.message}`);
      }
      reject(err);
    });
    cp.on("close", (code) => {
      clearTimeout(timeout);
      if (outputChannel) {
        outputChannel.appendLine(`[spawnSlicerMap] exit code=${code}`);
        if (stderr) outputChannel.appendLine(`[spawnSlicerMap] full stderr: ${stderr}`);
      }
      if (code === 0) return resolve(stdout);
      const sub = mode === "module-network" ? "--graph-modules" : "--map";
      reject(new Error(`context-slicer ${sub} failed (code ${code}) (bin=${bin}, cwd=${workspaceRoot}): ${stderr || stdout}`));
    });
  });

  if (!jsonText.trim().length) {
    const sub = mode === "module-network" ? "--graph-modules" : "--map";
    throw new Error(`context-slicer ${sub} returned empty stdout (bin=${bin}, cwd=${workspaceRoot})`);
  }

  const parsed = JSON.parse(jsonText) as any;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error(`Invalid map JSON output (first 200 chars): ${jsonText.slice(0, 200)}`);
  }
  return parsed as RepoMap | ModuleGraph;
}
