import * as vscode from "vscode";
import { isAbsolute, join } from "node:path";
import { spawnSlicerMap } from "./spawnMap";
import { spawnSlicerXml } from "./spawnSlicer";
import { spawnInspector } from "./spawnInspector";

type WebviewMessage =
  | { command: "refreshMap"; budgetTokens?: number; targetPath?: string }
  | { command: "focusNode"; target: string; budgetTokens?: number; action?: "open" | "copy" }
  | { command: "inspectNode"; targetPath: string }
  | { command: "openFileAt"; file: string; line: number };

type ExtensionMessage =
  | { type: "UPDATE_GRAPH"; payload: any }
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

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("AnvilHolo", { log: true });
  out.appendLine("[activate] AnvilHolo activated");

  context.subscriptions.push(
    vscode.commands.registerCommand("anvilHolo.debugWrite", async () => {
      out.appendLine("[command] anvilHolo.debugWrite");
      try {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error("No workspace folder open");

        const workspaceRoot = folder.uri.fsPath;
        const outDir = vscode.Uri.joinPath(folder.uri, ".context-slicer");
        const fileUri = vscode.Uri.joinPath(outDir, "hello.txt");

        out.appendLine(`[debugWrite] workspaceRoot=${workspaceRoot}`);
        out.appendLine(`[debugWrite] writing=${fileUri.fsPath}`);

        await vscode.workspace.fs.createDirectory(outDir);
        await vscode.workspace.fs.writeFile(
          fileUri,
          Buffer.from(`hello from AnvilHolo\n${new Date().toISOString()}\nworkspaceRoot=${workspaceRoot}\n`, "utf8")
        );

        vscode.window.showInformationMessage(`✅ AnvilHolo: Wrote ${fileUri.fsPath}`);
      } catch (e: any) {
        const errText = e?.message || String(e);
        out.appendLine(`[debugWrite] ERROR: ${errText}`);
        vscode.window.showErrorMessage(`❌ AnvilHolo: debugWrite failed: ${errText}`);
      }
    }),
    vscode.commands.registerCommand("anvilHolo.open", async () => {
      out.appendLine("[command] anvilHolo.open");
      const panel = vscode.window.createWebviewPanel(
        "anvilHolo",
        "AnvilHolo",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);

      const post = (msg: ExtensionMessage) => panel.webview.postMessage(msg);

      panel.webview.onDidReceiveMessage(
        async (msg: WebviewMessage) => {
          out.appendLine(`[webview->ext] ${JSON.stringify(msg)}`);

          if (msg.command === "refreshMap") {
            try {
              post({ type: "STATUS", text: "Mapping workspace..." });
              const map = await spawnSlicerMap(context.extensionUri, out, msg.targetPath);
              out.appendLine(`[refreshMap] map nodes=${map.nodes?.length ?? 0} edges=${map.edges?.length ?? 0}`);
              post({ type: "UPDATE_GRAPH", payload: map });
              post({ type: "STATUS", text: "Ready" });
            } catch (e: any) {
              const errText = e?.message || String(e);
              out.appendLine(`[refreshMap] ERROR: ${errText}`);
              post({ type: "STATUS", text: `Map failed: ${errText}` });
              vscode.window.showErrorMessage(`AnvilHolo map failed: ${errText}`);
            }
            return;
          }

          if (msg.command === "focusNode") {
            post({ type: "STATUS", text: `Slicing: ${msg.target}` });
            try {
              const action = msg.action ?? "open";
              const budgetTokens = Number.isFinite(msg.budgetTokens as any) ? Number(msg.budgetTokens) : undefined;
              const result = await spawnSlicerXml(context.extensionUri, msg.target, {
                budgetTokens,
                writeFile: action === "open",
                outputChannel: out
              });

              if (action === "open") {
                vscode.window.showInformationMessage(`✅ AnvilHolo: Context sliced to ${result.outputPath}`);
              }

              const estTokens = Math.ceil(result.xml.length / 4);
              post({
                type: "SLICE_RESULT",
                ok: true,
                target: msg.target,
                outputPath: result.outputPath,
                xmlChars: result.xml.length,
                estTokens,
                budgetTokens
              });

              if (action === "copy") {
                await vscode.env.clipboard.writeText(result.xml);
                post({ type: "STATUS", text: "Copied XML to clipboard" });
                return;
              }

              post({ type: "STATUS", text: "Slice generated" });

              // Open the generated XML file.
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.outputPath));
              await vscode.window.showTextDocument(doc, { preview: false });
            } catch (e: any) {
              const errText = e?.message || String(e);
              post({
                type: "SLICE_RESULT",
                ok: false,
                target: msg.target,
                error: errText
              });
              post({ type: "STATUS", text: "Slice failed" });
              out.appendLine(`[focusNode] ERROR: ${errText}`);
              vscode.window.showErrorMessage(`❌ AnvilHolo: Slice failed: ${errText}`);
            }
            return;
          }

          if (msg.command === "inspectNode") {
            try {
              post({ type: "STATUS", text: `Inspecting: ${msg.targetPath}` });
              const inspected = await spawnInspector(context.extensionUri, msg.targetPath, { outputChannel: out });
              post({ type: "INSPECT_RESULT", ok: true, targetPath: msg.targetPath, payload: inspected });
              post({ type: "STATUS", text: "Ready" });
            } catch (e: any) {
              const errText = e?.message || String(e);
              out.appendLine(`[inspectNode] ERROR: ${errText}`);
              post({ type: "INSPECT_RESULT", ok: false, targetPath: msg.targetPath, error: errText });
              post({ type: "STATUS", text: `Inspect failed: ${errText}` });
              vscode.window.showErrorMessage(`❌ AnvilHolo: Inspect failed: ${errText}`);
            }
            return;
          }

          if (msg.command === "openFileAt") {
            try {
              const folder = vscode.workspace.workspaceFolders?.[0];
              if (!folder) throw new Error("No workspace folder open");

              const workspaceRoot = folder.uri.fsPath;
              const filePath = isAbsolute(msg.file) ? msg.file : join(workspaceRoot, msg.file);

              const uri = vscode.Uri.file(filePath);
              const doc = await vscode.workspace.openTextDocument(uri);
              const editor = await vscode.window.showTextDocument(doc, { preview: false });
              const line = Math.max(0, Math.min(doc.lineCount - 1, Math.floor(Number(msg.line) || 0)));
              const pos = new vscode.Position(line, 0);
              editor.selection = new vscode.Selection(pos, pos);
              editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch (e: any) {
              const errText = e?.message || String(e);
              out.appendLine(`[openFileAt] ERROR: ${errText}`);
              vscode.window.showErrorMessage(`❌ AnvilHolo: Open failed: ${errText}`);
            }
            return;
          }
        },
        undefined,
        context.subscriptions
      );
    })
  );
}

export function deactivate() {}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const webviewCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.css"));
  const nonce = String(Date.now());

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AnvilHolo</title>
  <link href="${webviewCss}" rel="stylesheet" />
  <style>
    html, body, #root {
      height: 100%;
      width: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${webviewJs}"></script>
</body>
</html>`;
}
