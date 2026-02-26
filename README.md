# CortexAST 🧠⚡

> **The AI-Native Code Intelligence Backend for LLM Agents**
> Pure Rust · MCP Server · Semantic Code Navigation · AST Time Machine · Self-Evolving Wasm Parsers

[![Rust](https://img.shields.io/badge/rust-1.80%2B-orange?logo=rust)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0-blue)](./CHANGELOG.md)

---

## What is CortexAST?

> 👁️ **CortexAST is the "eyes"** — read-only code intelligence. For write/execute capabilities, see the companion [`cortex-act`](https://github.com/DevsHero/cortex-act) project (the "hands").

CortexAST is a **production-grade MCP (Model Context Protocol) server** that gives AI coding agents (Claude, Gemini, GPT-4o, etc.) the ability to:

- **Navigate codebases semantically** — find symbols, blast-radius analysis, cross-file propagation checklists
- **Evolve itself** — download and hot-reload WebAssembly language parsers at runtime (Go, PHP, Ruby, Java, …)
- **Time-travel your codebase** — Chronos snapshot system for pre/post-refactor AST-level comparison
- **Search local memory** — hybrid semantic + keyword search over your codebase history

> ✋ To **edit files**, **run commands**, or **patch configs**, use [cortex-act](https://github.com/DevsHero/cortex-act) instead.

---

## Feature Modules

### 1. 🔭 cortex_code_explorer
Codebase explorer. Use INSTEAD of ls/tree/find/cat. Two modes: `map_overview` (fast symbol map, near-zero tokens — run first on any repo) and `deep_slice` (token-budgeted XML with function bodies, vector-ranked by query). Use map_overview to orient; deep_slice to get code for editing.

### 2. 🎯 cortex_symbol_analyzer
AST symbol analysis. Use INSTEAD of grep/rg. Actions: `read_source` (extract exact source of a symbol from a file — do this before editing), `find_usages` (all call/type/field sites), `find_implementations` (structs implementing a trait), `blast_radius` (callers + callees — run before rename/delete), `propagation_checklist` (exhaustive update checklist for shared types).

### 3. ⏳ cortex_chronos
AST snapshot tool for safe refactors. Workflow: `save_checkpoint` (before edit) → edit → `compare_checkpoint` (verify). Use instead of git diff — AST-level, ignores formatting noise. Actions: `save_checkpoint`, `list_checkpoints`, `compare_checkpoint`, `delete_checkpoint`.

### 4. 🛠️ run_diagnostics
Run compiler diagnostics (cargo check / tsc / gcc). Call after any code edit to catch errors before proceeding. Returns file, line, code, message — structured for targeted fixes.

### 5. 🧠 cortex_memory_retriever
Search past agent decisions in global memory (semantic + keyword hybrid). **Requires CortexSync.** Call BEFORE any research or exploration — the answer may already be cached. Returns ranked entries: intent, decision, tags, files_touched.

### 6. 📋 cortex_get_rules
Fetch codebase AI rules for the current context. **Requires CortexSync.** Returns merged rules filtered by file_path (frontend/backend/db context). Call before starting any task in a new project.

### 7. ✨ cortex_remember
Save task outcome to permanent global memory. **Requires CortexSync.** Call at END of every task. intent+decision must be ≤200 chars each. For long artifacts write a file first and pass path via heavy_artifacts.

### 8. 🌍 cortex_list_network
List all AI-tracked codebases (**Requires CortexSync** network). Use to discover `target_project` IDs for cross-project operations.

### 9. 🌐 cortex_manage_ast_languages
Manage Wasm grammar parsers for non-core languages. Core (always active): rust, typescript, python. Call `status` to see active/available languages. Call `add` with `languages[]` to download and hot-reload parsers from GitHub tree-sitter releases. Available: go, php, cpp, c, c_sharp, java, ruby, dart.

---

## Ecosystem Requirement: CortexSync 🧠

For full functionality, **CortexSync** (the "Brain") must be running in the background.

| Tool | Dependent on CortexSync? | Why? |
|---|---|---|
| `cortex_remember` | **Yes** | Persists task outcomes to the global journal. |
| `cortex_memory_retriever`| **Yes** | Performs semantic vector search over past decisions. |
| `cortex_get_rules` | **Yes** | Fetches centralized rules from the synchronized rule engine. |
| `cortex_list_network` | **Yes** | Reads the global network map of codebases. |
| `cortex_code_explorer` | No | Local AST analysis. |
| `cortex_symbol_analyzer` | No | Local AST analysis. |

If `cortex-sync` is offline, these tools will strictly return a graceful warning without interrupting the agent's workflow.

---

---

## Quick Start

### Prerequisites
- Rust 1.80+
- Ollama or [LM Studio](https://lmstudio.ai) running locally (optional, for Auto-Healer)

### Build & Run
```bash
git clone https://github.com/DevsHero/CortexAST
cd CortexAST
cargo build --release

# Run as MCP server (stdio)
./target/release/cortexast
```

### MCP Config (`~/.cursor/mcp.json` or Claude Desktop)
```json
{
  "mcpServers": {
    "cortexast": {
      "command": "/path/to/cortexast",
      "args": []
    }
  }
}
```

---

---

## Usage Examples

### Semantic Explorer — Bird's-eye view of a project
```json
{
  "name": "cortex_code_explorer",
  "arguments": {
    "action": "map_overview",
    "target_dir": "."
  }
}
```

### Symbol Search — Find all usages across the repo
```json
{
  "name": "cortex_symbol_analyzer",
  "arguments": {
    "action": "find_usages",
    "symbol_name": "AuthService",
    "target_dir": "."
  }
}
```

### Time Travel — Compare AST after refactor
```json
{
  "name": "cortex_chronos",
  "arguments": {
    "action": "compare_checkpoint",
    "symbol_name": "login",
    "tag_a": "pre-refactor",
    "tag_b": "__live__"
  }
}
```


## Self-Evolving Wasm Language Support

| Always Available | Downloadable on Demand |
|---|---|
| Rust, TypeScript/JS, Python | Go, PHP, Ruby, Java, C, C++, C#, Dart |

```bash
# Agent calls this automatically when it detects a new language:
cortex_manage_ast_languages { "action": "add", "languages": ["go", "dart"] }
```

---

## Development

```bash
# Run all unit tests
cargo test

# Check (no link)
cargo check

---

## Architecture

```
CortexAST (binary)
└── src/
    ├── server.rs         # MCP stdio server — all tool schemas + handlers
    ├── inspector.rs      # LanguageConfig, LanguageDriver, Symbol, run_query
    ├── grammar_manager.rs # Wasm download + hot-reload (GitHub releases)
    ├── vector_store.rs    # model2vec embeddings + cache invalidation
    ├── chronos.rs         # AST snapshot time machine (Chronos)
    ├── memory.rs          # global_memory.jsonl journal client
    └── project_map.rs     # Network map for multi-repo roaming
```


## License

MIT — See [LICENSE](./LICENSE)

---

*Built with ❤️ in Rust · Semantic precision for the AI age*