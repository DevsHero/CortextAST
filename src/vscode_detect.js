import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { normalizeModelName } from "./model.js";

function tryExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: res.status === 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function detectModelFromVSCodeGlobalState() {
  const home = homedir();
  const appData = process.env.APPDATA;

  const candidates = [];

  // macOS
  candidates.push(join(home, "Library", "Application Support", "Code", "User", "globalStorage", "state.vscdb"));
  candidates.push(join(home, "Library", "Application Support", "Code - Insiders", "User", "globalStorage", "state.vscdb"));

  // Linux
  candidates.push(join(home, ".config", "Code", "User", "globalStorage", "state.vscdb"));
  candidates.push(join(home, ".config", "Code - Insiders", "User", "globalStorage", "state.vscdb"));

  // Windows
  if (appData) {
    candidates.push(join(appData, "Code", "User", "globalStorage", "state.vscdb"));
    candidates.push(join(appData, "Code - Insiders", "User", "globalStorage", "state.vscdb"));
  }

  const hasSqlite = tryExec("sqlite3", ["--version"]).ok;
  if (!hasSqlite) return null;

  for (const p of candidates) {
    if (!existsSync(p)) continue;

    const snapshot = join(tmpdir(), `vscode-state-${process.pid}-${Math.random().toString(16).slice(2)}.vscdb`);
    try {
      copyFileSync(p, snapshot);
    } catch {
      continue;
    }

    const q = "select cast(value as text) from ItemTable where key='GitHub.copilot-chat';";
    const res = tryExec("sqlite3", [snapshot, q]);
    if (!res.ok) continue;

    try {
      const parsed = JSON.parse(res.stdout);
      const raw = parsed?.["VSCode.ABExp.FeatureData"]?.value?.configs?.[0]?.Parameters?.["chat.defaultLanguageModel"];
      if (typeof raw === "string" && raw.length) {
        const model = normalizeModelName(raw);
        if (model) return model;
      }
    } catch {
      // ignore
    }
  }

  return null;
}
