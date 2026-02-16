import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

const exe = process.platform === "win32" ? "dist/context-slicer.exe" : "dist/context-slicer";
if (!existsSync(exe)) {
  throw new Error(`Missing binary: ${exe}. Run npm run build:binary first.`);
}

// CLI test
run(exe, ["--help"], { stdio: "pipe" });
run(exe, ["focus-auto", "mixer"], { stdio: "pipe", cwd: process.cwd() });

console.log("binary CLI ok");
