import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { findSlicerBinary } from "./spawnMap";

export type FileSymbol = {
  name: string;
  kind: string;
  line: number;
  line_end: number;
  signature?: string | null;
};

export type FileSymbols = {
  file: string;
  symbols: FileSymbol[];
};

export async function spawnInspector(
  extensionUri: vscode.Uri,
  targetPath: string,
  opts?: { outputChannel?: vscode.OutputChannel; timeoutMs?: number }
): Promise<FileSymbols> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");

  const workspaceRoot = folder.uri.fsPath;
  const bin = findSlicerBinary(workspaceRoot, extensionUri.fsPath);

  const absTarget = isAbsolute(targetPath) ? targetPath : join(workspaceRoot, targetPath);

  const timeoutMs = Number.isFinite(opts?.timeoutMs as any) ? Number(opts!.timeoutMs) : 8000;

  if (opts?.outputChannel) {
    opts.outputChannel.appendLine(`[spawnInspector] bin=${bin}`);
    opts.outputChannel.appendLine(`[spawnInspector] cwd=${workspaceRoot}`);
    opts.outputChannel.appendLine(`[spawnInspector] cmd: ${bin} --inspect ${absTarget}`);
  }

  const jsonText = await new Promise<string>((resolve, reject) => {
    const cp = spawn(bin, ["--inspect", absTarget], { cwd: workspaceRoot });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      try {
        cp.kill();
      } catch {
        // ignore
      }
      reject(new Error(`context-slicer --inspect timed out after ${timeoutMs}ms (bin=${bin}, cwd=${workspaceRoot})`));
    }, timeoutMs);

    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");

    cp.stdout.on("data", (d) => (stdout += d));
    cp.stderr.on("data", (d) => {
      stderr += d;
      if (opts?.outputChannel) {
        opts.outputChannel.appendLine(`[spawnInspector] stderr: ${d}`);
      }
    });

    cp.on("error", (err) => {
      clearTimeout(timeout);
      if (opts?.outputChannel) {
        opts.outputChannel.appendLine(`[spawnInspector] spawn error: ${err.message}`);
      }
      reject(err);
    });

    cp.on("close", (code) => {
      clearTimeout(timeout);
      if (opts?.outputChannel) {
        opts.outputChannel.appendLine(`[spawnInspector] exit code=${code}`);
        if (stderr) opts.outputChannel.appendLine(`[spawnInspector] full stderr: ${stderr}`);
      }
      if (code === 0) return resolve(stdout);
      reject(new Error(`context-slicer --inspect failed (code ${code}): ${stderr || stdout}`));
    });
  });

  if (!jsonText.trim().length) {
    throw new Error(`context-slicer --inspect returned empty stdout (bin=${bin}, cwd=${workspaceRoot})`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e: any) {
    throw new Error(
      `Invalid --inspect JSON output (first 200 chars): ${jsonText.slice(0, 200)} (${e?.message || String(e)})`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid --inspect output: not an object");
  }
  if (typeof parsed.file !== "string") {
    throw new Error("Invalid --inspect output: missing 'file' string");
  }
  if (!Array.isArray(parsed.symbols)) {
    throw new Error("Invalid --inspect output: missing 'symbols' array");
  }

  return parsed as FileSymbols;
}
