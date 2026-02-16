import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function parseTotalTokens(text) {
  const m = text.match(/Total Tokens:\s*([0-9,]+)\s*tokens/i);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

function resolveLocalRepomixBin() {
  // This file lives at: <pkgRoot>/src/repomix_runner.js
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = dirname(here);
  const binDir = join(pkgRoot, "node_modules", ".bin");
  const name = process.platform === "win32" ? "repomix.cmd" : "repomix";
  const candidate = join(binDir, name);
  return existsSync(candidate) ? candidate : null;
}

export function runRepomix(args, repoRoot) {
  const localBin = resolveLocalRepomixBin();
  const cmd = localBin ?? "repomix";
  const res = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status ?? 1, combined: `${stdout}\n${stderr}` };
}
