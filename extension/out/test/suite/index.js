"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/test/suite/index.ts
var suite_exports = {};
__export(suite_exports, {
  run: () => run
});
module.exports = __toCommonJS(suite_exports);

// src/test/suite/rust.test.ts
var assert = __toESM(require("node:assert"));
var vscode = __toESM(require("vscode"));
async function runRustIntegrationTest() {
  const extId = "devshero.anvil-holo";
  const ext = vscode.extensions.getExtension(extId);
  assert.ok(ext, `Expected extension ${extId} to be installed in test host`);
  const api = await ext.activate();
  assert.ok(api && typeof api.spawnSlicerMap === "function", "Expected extension to export spawnSlicerMap API");
  const out = {
    appendLine: (line) => console.log(String(line).replace(/\n$/, ""))
  };
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "Expected a workspace folder to be open in the test host");
  const candidates = ["core/Cargo.toml", "package.json"];
  let manifest = candidates[candidates.length - 1];
  for (const c of candidates) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, c));
      manifest = c;
      break;
    } catch {
    }
  }
  console.log(`[test] Calling spawnSlicerMap with --manifests ${manifest}`);
  let map;
  try {
    map = await api.spawnSlicerMap(ext.extensionUri, out, void 0, "module-network", [manifest]);
    console.log("[test] Rust JSON (raw):\n" + JSON.stringify(map, null, 2));
  } catch (e) {
    console.error("[test] spawnSlicerMap threw:", e?.message || String(e));
    throw e;
  }
  const nodesLen = Array.isArray(map?.nodes) ? map.nodes.length : 0;
  console.log("[test] nodes=", nodesLen, "edges=", Array.isArray(map?.edges) ? map.edges.length : 0);
  assert.ok(nodesLen > 0, "Expected module graph nodes.length > 0 (Rust returned empty graph)");
}

// src/test/suite/index.ts
async function run() {
  await runRustIntegrationTest();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});
//# sourceMappingURL=index.js.map
