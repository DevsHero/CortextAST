export function normalizeModelName(raw) {
  const s0 = (raw ?? "").trim().toLowerCase();
  if (!s0) return "";

  const beforeAt = s0.split("@")[0] ?? s0;
  const cleaned = beforeAt.startsWith("copilot/") ? beforeAt.slice("copilot/".length) : beforeAt;

  return cleaned
    .replace(/^gpt\s*/i, "gpt-")
    .replace(/\s+/g, "-")
    .replace(/\(preview\)/g, "")
    .replace(/--+/g, "-")
    .trim();
}

export function resolveModelKey(model, ctx) {
  if (ctx.models?.[model]) return model;
  const keys = Object.keys(ctx.models ?? {});
  const found = keys.find((k) => model === k || model.startsWith(`${k}-`));
  return found ?? model;
}

export function budgetForModel(model, ctx) {
  const modelKey = resolveModelKey(model, ctx);
  const entry = ctx.models?.[modelKey];
  const windowTokens = entry?.contextWindowTokens ?? ctx.models?.["gpt-4.1"]?.contextWindowTokens ?? 64000;
  const target = Math.floor(windowTokens * (ctx.policy?.targetFractionOfContext ?? 0.25));
  const minB = ctx.policy?.minBudgetTokens ?? 6000;
  const maxB = ctx.policy?.maxBudgetTokens ?? 60000;
  return Math.min(maxB, Math.max(minB, target));
}
