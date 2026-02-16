export const DEFAULT_MODEL_CONTEXTS = {
  // Keep conservative defaults; allow override via config.
  models: {
    "gpt-4.1": { contextWindowTokens: 64000 },
    "gpt-4o": { contextWindowTokens: 64000 },
    "gpt-5": { contextWindowTokens: 128000 },
    "gpt-5-mini": { contextWindowTokens: 128000 },
    "gpt-5.1": { contextWindowTokens: 128000 },
    "gpt-5.1-codex": { contextWindowTokens: 128000 },
    "gpt-5.2": { contextWindowTokens: 128000 },
    "gpt-5.2-codex": { contextWindowTokens: 272000 },
    "gpt-5.3-codex": { contextWindowTokens: 272000 }
  },
  policy: {
    targetFractionOfContext: 0.25,
    minBudgetTokens: 6000,
    maxBudgetTokens: 60000
  }
};

export const DEFAULT_OUTPUT_DIR = ".context-slicer";
