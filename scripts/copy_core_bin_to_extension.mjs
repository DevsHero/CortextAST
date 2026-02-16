import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const isWin = process.platform === "win32";
const binName = isWin ? "context-slicer.exe" : "context-slicer";

const src = join(repoRoot, "core", "target", "release", binName);
const destDir = join(repoRoot, "extension", "bin");
const dest = join(destDir, binName);

if (!existsSync(src)) {
  console.error(`Missing core binary: ${src}`);
  console.error("Run: npm run build:core");
  process.exit(2);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
if (!isWin) {
  try {
    chmodSync(dest, 0o755);
  } catch {
    // ignore
  }
}

console.log(`Copied ${src} -> ${dest}`);
