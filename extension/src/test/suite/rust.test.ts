import * as assert from "node:assert";
import * as vscode from "vscode";

type AnvilHoloApi = {
  spawnSlicerMap?: (...args: any[]) => Promise<any>;
};

export async function runRustIntegrationTest(): Promise<void> {
  const extId = "devshero.anvil-holo";
  const ext = vscode.extensions.getExtension<AnvilHoloApi>(extId);
  assert.ok(ext, `Expected extension ${extId} to be installed in test host`);

  // Activate without opening UI.
  const api = (await ext!.activate()) as AnvilHoloApi;
  assert.ok(api && typeof api.spawnSlicerMap === "function", "Expected extension to export spawnSlicerMap API");

  // OutputChannel-like sink that prints to the test runner console.
  const out = {
    appendLine: (line: string) => console.log(String(line).replace(/\n$/, ""))
  } as any;

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "Expected a workspace folder to be open in the test host");

    // Prefer a small manifest so the test stays fast/stable.
    const candidates = ["core/Cargo.toml", "package.json"];
    let manifest = candidates[candidates.length - 1];
    for (const c of candidates) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder!.uri, c));
        manifest = c;
        break;
      } catch {
        // continue
      }
    }

    console.log(`[test] Calling spawnSlicerMap with --manifests ${manifest}`);

  // spawnSlicerMap(extensionUri, outputChannel, targetPath, mode, manifests)
  let map: any;
  try {
      map = await api.spawnSlicerMap!(ext!.extensionUri, out, undefined, "module-network", [manifest]);
    console.log("[test] Rust JSON (raw):\n" + JSON.stringify(map, null, 2));
  } catch (e: any) {
    console.error("[test] spawnSlicerMap threw:", e?.message || String(e));
    throw e;
  }

  const nodesLen = Array.isArray(map?.nodes) ? map.nodes.length : 0;
  console.log("[test] nodes=", nodesLen, "edges=", Array.isArray(map?.edges) ? map.edges.length : 0);
  assert.ok(nodesLen > 0, "Expected module graph nodes.length > 0 (Rust returned empty graph)");
}
