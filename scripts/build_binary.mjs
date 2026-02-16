import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
}

function readStdout(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (res.status !== 0) return null;
  return (res.stdout ?? "").toString();
}

mkdirSync("dist", { recursive: true });

// 1) Bundle app to a single CommonJS file (SEA supports CommonJS only).
run(process.execPath, ["scripts/bundle.mjs"], { cwd: process.cwd() });

// 2) Generate SEA preparation blob.
const seaConfig = {
  main: "dist/context-slicer.bundle.cjs",
  output: "dist/sea-prep.blob",
  disableExperimentalSEAWarning: true
};
writeFileSync("dist/sea-config.json", JSON.stringify(seaConfig, null, 2), "utf8");
run(process.execPath, ["--experimental-sea-config", "dist/sea-config.json"], { cwd: process.cwd() });

// 3) Copy current node binary to output name.
const outName = process.platform === "win32" ? "context-slicer.exe" : "context-slicer";
const outPath = join("dist", outName);
copyFileSync(process.execPath, outPath);
try {
  chmodSync(outPath, 0o755);
} catch {
  // ignore on Windows
}

// macOS: universal binaries contain the SEA fuse sentinel multiple times.
// Thin to the current arch before injection so postject can find a single sentinel.
if (process.platform === "darwin") {
  const arch = (readStdout("uname", ["-m"]) ?? "arm64").trim();
  // Remove existing signature to avoid warnings/errors when modifying Mach-O.
  spawnSync("codesign", ["--remove-signature", outPath], { stdio: "ignore" });

  const thinTmp = join("dist", `${outName}.${arch}.thin`);
  run("lipo", [outPath, "-thin", arch, "-output", thinTmp], { cwd: process.cwd() });
  copyFileSync(thinTmp, outPath);
  try {
    chmodSync(outPath, 0o755);
  } catch {}
}

// Determine sentinel fuse value (Node embeds a version-specific hash).
// Example: NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
let sentinelFuse = "NODE_SEA_FUSE";
try {
  const bin = readFileSync(outPath);
  const asText = bin.toString("latin1");
  const m = asText.match(/NODE_SEA_FUSE_[a-f0-9]{32}/i);
  if (m?.[0]) sentinelFuse = m[0];
} catch {
  // fallback: keep default
}

// 4) Inject blob into the copied node binary using postject.
// Node expects the resource name NODE_SEA_BLOB and sentinel-fuse NODE_SEA_FUSE.
const postjectCli = process.platform === "win32"
  ? join("node_modules", "postject", "dist", "cli.js")
  : join("node_modules", "postject", "dist", "cli.js");

const postjectArgs = [
  postjectCli,
  outPath,
  "NODE_SEA_BLOB",
  "dist/sea-prep.blob",
  "--sentinel-fuse",
  sentinelFuse
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run(process.execPath, postjectArgs, { cwd: process.cwd() });

// Re-sign ad-hoc (optional but nice) so the binary runs without quarantine friction.
if (process.platform === "darwin") {
  spawnSync("codesign", ["--sign", "-", outPath], { stdio: "ignore" });
}

console.log(`Built ${outPath}`);
