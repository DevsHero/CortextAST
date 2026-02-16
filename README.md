# context-slicer

Cross-platform **context slicing** for coding agents:
- CLI for humans + CI
- MCP server so agents can call it from any IDE
- Single-binary distribution (SEA) for zero-install runtime
- Dynamic token budgeting per model (auto-detected when possible)

## Why CLI + MCP (not only a VS Code extension)
- **CLI** works anywhere (VS Code, JetBrains, Cursor, CI, headless agents).
- **MCP** makes it callable by agents without custom IDE integrations.
- A VS Code extension can be added later as an optional UX layer.

## Zero-install runtime (single binary)
The goal is: users download one executable and run it — no Node.js, no npm.

Build artifacts live in `dist/`:
- macOS/Linux: `dist/context-slicer`
- Windows: `dist/context-slicer.exe`

### Build from source
Requirements (build-time only): Node.js >= 20

From this folder:
- `npm install --cache /tmp/npm-cache-context-slicer`
- `npm run build:binary`

Then run (from any repo root):
- `path/to/dist/context-slicer focus-auto <target>`
- `path/to/dist/context-slicer mcp`

## Usage

### CLI
From any repo root:
- `context-slicer focus-auto <target> [model]`

Example:
- `context-slicer focus-auto mixer`

Outputs:
- `.context-slicer/active_context.xml`
- `.context-slicer/active_context.meta.json`

### MCP server (stdio)
Start server:
- `context-slicer mcp`

Exposes tool:
- `context_slicer_focus_auto`

## Config (optional, single file)
Create `.context-slicer.json` in repo root to override model windows/budgets/presets.

Example:

```json
{
	"outputDir": ".context-slicer",
	"preset": "auto",
	"modelContexts": {
		"models": {
			"gpt-4.1": { "contextWindowTokens": 64000 }
		},
		"policy": {
			"targetFractionOfContext": 0.25,
			"minBudgetTokens": 6000,
			"maxBudgetTokens": 60000
		}
	},
	"tokenEstimator": {
		"charsPerToken": 4,
		"maxFileBytes": 1048576
	}
}
```

---

## Notes
- Model auto-detection is best-effort. On VS Code, it attempts to read the last-selected `chat.defaultLanguageModel` from VS Code global state (when `sqlite3` is available). Otherwise it falls back safely.
- For release distribution, publish prebuilt binaries for macOS/Linux/Windows.
