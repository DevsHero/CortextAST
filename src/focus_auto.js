import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { budgetForModel, normalizeModelName } from "./model.js";
import { detectModelFromVSCodeGlobalState } from "./vscode_detect.js";
import { detectPreset, repomixArgsFor } from "./preset.js";
import { buildXml, estimateTokensFromBytes, listFiles, sumFileSizes } from "./packer.js";

function chooseModes(budgetTokens) {
  if (budgetTokens >= 45000) return ["full", "lite", "lite-compress", "lite-compress-min"];
  if (budgetTokens >= 20000) return ["lite", "lite-compress", "lite-compress-min"];
  return ["lite-compress", "lite-compress-min"];
}

export async function focusAuto({ repoRoot, target, modelId, budgetTokens }) {
  const cfg = loadConfig(repoRoot);
  const outDir = join(repoRoot, cfg.outputDir);
  mkdirSync(outDir, { recursive: true });

  const envModel = process.env.COPILOT_MODEL || process.env.VSCODE_COPILOT_MODEL || process.env.LM_MODEL;
  const detected = detectModelFromVSCodeGlobalState();
  const resolvedModel =
    normalizeModelName(modelId) || normalizeModelName(envModel) || detected || "gpt-4.1";

  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : budgetForModel(resolvedModel, cfg.modelContexts);

  const preset = cfg.preset === "auto" ? detectPreset(repoRoot) : cfg.preset;

  const modes = chooseModes(budget);
  for (const mode of modes) {
    const plan = repomixArgsFor(preset, target, cfg.outputDir, mode);
    const include = plan.include;

    const filePaths = await listFiles({ repoRoot, include });
    const totalBytes = sumFileSizes(filePaths);
    const estTokens = estimateTokensFromBytes(totalBytes, cfg.tokenEstimator.charsPerToken);

    if (estTokens <= budget) {
      const built = buildXml({
        repoRoot,
        filePaths,
        maxFileBytes: cfg.tokenEstimator.maxFileBytes,
        removeEmptyLines: true
      });

      writeFileSync(join(outDir, "active_context.xml"), built.xml, "utf8");

      const meta = {
        repoRoot,
        preset,
        target,
        model: resolvedModel,
        budgetTokens: budget,
        mode,
        totalTokens: estTokens,
        totalFiles: built.totalFiles,
        totalChars: built.totalChars
      };

      writeFileSync(join(outDir, "active_context.meta.json"), JSON.stringify(meta, null, 2), "utf8");
      return meta;
    }
  }

  throw new Error(`Unable to generate slice within budget=${budget} tokens`);
}
