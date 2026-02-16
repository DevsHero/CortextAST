import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { findSlicerBinary } from "./spawnMap";

export async function spawnSlicerXml(
  extensionUri: vscode.Uri,
  target: string,
  opts?: { budgetTokens?: number; writeFile?: boolean; outputChannel?: vscode.OutputChannel }
): Promise<{ xml: string; outputPath: string }> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");

  const workspaceRoot = folder.uri.fsPath;
  const bin = findSlicerBinary(workspaceRoot, extensionUri.fsPath);

  const outDir = join(workspaceRoot, ".context-slicer");
  const outputPath = join(outDir, "active_context.xml");

  const args = ["--target", target, "--xml"];
  if (Number.isFinite(opts?.budgetTokens as any)) {
    args.push("--budget-tokens", String(opts!.budgetTokens));
  }

  if (opts?.outputChannel) {
    opts.outputChannel.appendLine(`[spawnSlicerXml] bin=${bin}`);
    opts.outputChannel.appendLine(`[spawnSlicerXml] cwd=${workspaceRoot}`);
    opts.outputChannel.appendLine(`[spawnSlicerXml] cmd: ${bin} ${args.join(" ")}`);
    opts.outputChannel.appendLine(`[spawnSlicerXml] outputPath=${outputPath}`);
  }

  const xml = await new Promise<string>((resolve, reject) => {
    const cp = spawn(bin, args, { cwd: workspaceRoot });

    let stdout = "";
    let stderr = "";

    cp.stdout.setEncoding("utf8");
    cp.stderr.setEncoding("utf8");

    cp.stdout.on("data", (d) => (stdout += d));
    cp.stderr.on("data", (d) => {
      stderr += d;
      if (opts?.outputChannel) {
        opts.outputChannel.appendLine(`[spawnSlicerXml] stderr: ${d}`);
      }
    });

    cp.on("error", (err) => {
      if (opts?.outputChannel) {
        opts.outputChannel.appendLine(`[spawnSlicerXml] spawn error: ${err.message}`);
      }
      reject(err);
    });
    cp.on("close", (code) => {
      if (opts?.outputChannel) {
        opts.outputChannel.appendLine(`[spawnSlicerXml] exit code=${code}`);
        if (stderr) opts.outputChannel.appendLine(`[spawnSlicerXml] full stderr: ${stderr}`);
      }
      if (code === 0) return resolve(stdout);
      reject(new Error(`context-slicer failed (code ${code}): ${stderr || stdout}`));
    });
  });

  const writeFile = opts?.writeFile !== false;
  if (writeFile) {
    if (opts?.outputChannel) {
      opts.outputChannel.appendLine("Attempting to write file to: " + outputPath);
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(outDir));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(outputPath), Buffer.from(xml, "utf8"));
  }

  // Option A (clipboard) can be added later; keeping output file as the default.
  return { xml, outputPath };
}
