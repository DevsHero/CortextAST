import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL_CONTEXTS, DEFAULT_OUTPUT_DIR } from "./defaults.js";

function isObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function deepMerge(base, extra) {
  if (!isObject(base) || !isObject(extra)) return extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function loadConfig(repoRoot) {
  const configPath = join(repoRoot, ".context-slicer.json");
  const user = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

  return {
    outputDir: user.outputDir ?? DEFAULT_OUTPUT_DIR,
    modelContexts: deepMerge(DEFAULT_MODEL_CONTEXTS, user.modelContexts ?? {}),
    preset: user.preset ?? "auto",
    tokenEstimator: {
      charsPerToken: user.tokenEstimator?.charsPerToken ?? 4,
      maxFileBytes: user.tokenEstimator?.maxFileBytes ?? 1024 * 1024
    }
  };
}
