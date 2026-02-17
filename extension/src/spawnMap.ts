import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

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
  mode: MapMode = "file-tree",
  manifests?: string[]
): Promise<RepoMap | ModuleGraph> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");

  const workspaceRoot = folder.uri.fsPath;
  const extensionRoot = extensionUri.fsPath;
  const bin = findSlicerBinary(workspaceRoot, extensionRoot);

  const cleanedManifests = Array.isArray(manifests)
    ? Array.from(new Set(manifests.map((p) => String(p || "").trim()).filter(Boolean)))
    : [];

  // Enforce the contract: Rust expects manifest paths relative to cwd (workspace root).
  // Also normalize slashes for cross-platform consistency.
  const normalizedManifests = cleanedManifests
    .map((p) => p.replace(/\\/g, "/"))
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";

      if (!isAbsolute(trimmed)) return trimmed;

      // If an absolute path slips through, only accept it if it's inside the workspace.
      const rel = relative(workspaceRoot, trimmed).replace(/\\/g, "/");
      if (!rel.startsWith("../") && rel !== "..") return rel;

      if (outputChannel) {
        outputChannel.appendLine(`[spawnSlicerMap] Dropping absolute manifest outside workspace: ${trimmed}`);
      }
      return "";
    })
    .filter(Boolean);

  const args = (normalizedManifests.length
    ? ["--manifests", ...normalizedManifests]
    : (mode === "module-network" ? ["--graph-modules"] : ["--map"])) as string[];

  if (!normalizedManifests.length) {
    if (typeof targetPath === "string" && targetPath.length) {
      args.push(targetPath);
    }
  }

  if (outputChannel) {
    outputChannel.appendLine(`[spawnSlicerMap] Mode: ${normalizedManifests.length ? "Manifest Scan" : mode}`);
    outputChannel.appendLine(`[spawnSlicerMap] bin=${bin}`);
    outputChannel.appendLine(`[spawnSlicerMap] cwd=${workspaceRoot}`);
    outputChannel.appendLine(`[spawnSlicerMap] cmd: ${bin} ${args.join(" ")}`);
  }

  const jsonText = await new Promise<string>((resolve, reject) => {
    const cp = spawn(bin, args, { cwd: workspaceRoot });

    let stdout = "";
    let stderr = "";

    const timeoutMs = normalizedManifests.length ? 20000 : 8000;
    const timeout = setTimeout(() => {
      try {
        cp.kill();
      } catch {
        // ignore
      }
      const sub = mode === "module-network" ? "--graph-modules" : "--map";
      const which = normalizedManifests.length ? "--manifests" : sub;
      reject(new Error(`context-slicer ${which} timed out after ${timeoutMs}ms (bin=${bin}, cwd=${workspaceRoot})`));
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
      const which = normalizedManifests.length ? "--manifests" : sub;
      reject(new Error(`context-slicer ${which} failed (code ${code}) (bin=${bin}, cwd=${workspaceRoot}): ${stderr || stdout}`));
    });
  });

  if (!jsonText.trim().length) {
    const sub = mode === "module-network" ? "--graph-modules" : "--map";
    const which = normalizedManifests.length ? "--manifests" : sub;
    throw new Error(`context-slicer ${which} returned empty stdout (bin=${bin}, cwd=${workspaceRoot})`);
  }

  const parsed = JSON.parse(jsonText) as any;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error(`Invalid map JSON output (first 200 chars): ${jsonText.slice(0, 200)}`);
  }
  return parsed as RepoMap | ModuleGraph;
}

export async function spawnSlicerManifests(
  extensionUri: vscode.Uri,
  manifestPaths: string[],
  outputChannel?: vscode.OutputChannel
): Promise<ModuleGraph> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");

  const workspaceRoot = folder.uri.fsPath;
  const extensionRoot = extensionUri.fsPath;
  const bin = findSlicerBinary(workspaceRoot, extensionRoot);

  const cleaned = Array.from(new Set(manifestPaths.map((p) => String(p || "").trim()).filter(Boolean)));
  if (!cleaned.length) {
    return { nodes: [], edges: [] };
  }

  const args = ["--manifests", ...cleaned];
  if (outputChannel) {
    outputChannel.appendLine(`[spawnSlicerManifests] bin=${bin}`);
    outputChannel.appendLine(`[spawnSlicerManifests] cwd=${workspaceRoot}`);
    outputChannel.appendLine(`[spawnSlicerManifests] cmd: ${bin} ${args.join(" ")}`);
  }

  const jsonText = await new Promise<string>((resolve, reject) => {
    const cp = spawn(bin, args, { cwd: workspaceRoot });

    let stdout = "";
    let stderr = "";

    const timeoutMs = 20000;
    const timeout = setTimeout(() => {
      try {
        cp.kill();
      } catch {
        // ignore
      }
      reject(new Error(`context-slicer --manifests timed out after ${timeoutMs}ms (bin=${bin}, cwd=${workspaceRoot})`));
    }, timeoutMs);

    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");

    cp.stdout.on("data", (d) => (stdout += d));
    cp.stderr.on("data", (d) => {
      stderr += d;
      if (outputChannel) outputChannel.appendLine(`[spawnSlicerManifests] stderr: ${d}`);
    });

    cp.on("error", (err) => {
      if (outputChannel) outputChannel.appendLine(`[spawnSlicerManifests] spawn error: ${err.message}`);
      reject(err);
    });
    cp.on("close", (code) => {
      clearTimeout(timeout);
      if (outputChannel) {
        outputChannel.appendLine(`[spawnSlicerManifests] exit code=${code}`);
        if (stderr) outputChannel.appendLine(`[spawnSlicerManifests] full stderr: ${stderr}`);
      }
      if (code === 0) return resolve(stdout);
      reject(new Error(`context-slicer --manifests failed (code ${code}) (bin=${bin}, cwd=${workspaceRoot}): ${stderr || stdout}`));
    });
  });

  if (!jsonText.trim().length) {
    throw new Error(`context-slicer --manifests returned empty stdout (bin=${bin}, cwd=${workspaceRoot})`);
  }

  const parsed = JSON.parse(jsonText) as any;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error(`Invalid graph JSON output (first 200 chars): ${jsonText.slice(0, 200)}`);
  }
  return parsed as ModuleGraph;
}
