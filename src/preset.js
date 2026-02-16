import { existsSync } from "node:fs";
import { join } from "node:path";

export function detectPreset(repoRoot) {
  // Heuristic: polylith-ish repos
  const hasApps = existsSync(join(repoRoot, "apps"));
  const hasLibs = existsSync(join(repoRoot, "libs"));
  const hasServices = existsSync(join(repoRoot, "services"));
  if (hasApps && (hasLibs || hasServices)) return "polylith";

  // dataset-mixer style (vite at root + src-tauri)
  if (existsSync(join(repoRoot, "src-tauri")) && existsSync(join(repoRoot, "src"))) return "tauri-root";

  return "generic";
}

export function repomixArgsFor(preset, target, outputDir, mode) {
  const include = (() => {
    if (preset === "tauri-root") {
      // target is a module under src/** or src-tauri/** (best effort)
      const mod = target;
      return [
        `src/**/${mod}/**`,
        `src-tauri/**/${mod}/**`,
        "src/**",
        "src-tauri/**",
        "docs/**",
        "README*",
        "package.json"
      ];
    }

    if (preset === "polylith") {
      const mod = target;
      return [
        `apps/desktop/src/modules/${mod}/**`,
        `apps/web/src/components/${mod}/**`,
        "libs/**",
        "proto/**",
        "docs/**",
        "README*"
      ];
    }

    // generic
    return [
      target && target.includes("*") ? target : `${target}/**`,
      "src/**",
      "lib/**",
      "docs/**",
      "README*",
      "package.json"
    ];
  })();

  return {
    include,
    mode
  };
}
