import * as vscode from "vscode";

export type ModuleType = "npm" | "cargo" | "dart" | "go";

export type DiscoveredModule = {
  path: string; // workspace-relative manifest path
  type: ModuleType;
};

function typeFromManifestName(fileName: string): ModuleType | null {
  const lower = fileName.toLowerCase();
  if (lower === "package.json") return "npm";
  if (lower === "cargo.toml") return "cargo";
  if (lower === "pubspec.yaml") return "dart";
  if (lower === "go.mod") return "go";
  return null;
}

function toWorkspaceRelativePath(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  // Normalize to forward slashes for consistency across webview + Rust CLI.
  return rel.replace(/\\/g, "/");
}

export async function discoverModules(): Promise<DiscoveredModule[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];

  const exclude = "**/{node_modules,target,dist}/**";
  const patterns = ["**/package.json", "**/Cargo.toml", "**/pubspec.yaml", "**/go.mod"];

  const results: DiscoveredModule[] = [];
  const seen = new Set<string>();

  for (const pat of patterns) {
    const uris = await vscode.workspace.findFiles(pat, exclude);
    for (const uri of uris) {
      const fileName = uri.path.split("/").pop() ?? "";
      const type = typeFromManifestName(fileName);
      if (!type) continue;

      const rel = toWorkspaceRelativePath(uri, folder);
      if (seen.has(rel)) continue;
      seen.add(rel);
      results.push({ path: rel, type });
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
