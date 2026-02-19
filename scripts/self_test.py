#!/usr/bin/env python3
"""Self-test runner: exercises all five neurosiphon MCP tools against dataset-mixer."""
import json, subprocess, sys, textwrap

NS = "/Users/hero/Documents/GitHub/context-slicer/target/release/neurosiphon"
REPO = "/Users/hero/Documents/GitHub/dataset-mixer"

def call_tool(name: str, args: dict) -> str:
    messages = [
        {"jsonrpc":"2.0","id":1,"method":"initialize",
         "params":{"protocolVersion":"2024-11-05","capabilities":{},
                   "clientInfo":{"name":"selftest","version":"1"}}},
        {"jsonrpc":"2.0","id":2,"method":"initialized","params":{}},
        {"jsonrpc":"2.0","id":3,"method":"tools/call",
         "params":{"name": name, "arguments": args}},
    ]
    stdin = "\n".join(json.dumps(m) for m in messages) + "\n"
    result = subprocess.run([NS, "mcp"], input=stdin, capture_output=True, text=True, timeout=60)
    lines = [l for l in result.stdout.strip().splitlines() if l.strip()]
    # Last line is the tools/call response
    for line in reversed(lines):
        try:
            d = json.loads(line)
            if d.get("id") == 3:
                content = d.get("result",{}).get("content",[{}])
                return content[0].get("text","") if content else str(d)
        except Exception:
            pass
    return f"PARSE_ERROR stdout={result.stdout!r} stderr={result.stderr!r}"

def section(title: str):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)

def show(text: str, max_lines: int = 30):
    lines = text.splitlines()
    for l in lines[:max_lines]:
        print(" ", l)
    if len(lines) > max_lines:
        print(f"  ... ({len(lines)-max_lines} more lines)")

# ── TEST 1: neurosiphon_repo_map ──────────────────────────────────────────────
section("TEST 1: repo_map — Rust (apps/desktop/src)")
out = call_tool("neurosiphon_repo_map", {"repoPath": REPO, "target_dir": "apps/desktop/src"})
show(out)

section("TEST 1b: repo_map — Python (services/py-mlx-bridge)")
out = call_tool("neurosiphon_repo_map", {"repoPath": REPO, "target_dir": "services/py-mlx-bridge/src"})
show(out)

section("TEST 1c: repo_map — WITHOUT repoPath (should error or auto-detect)")
out = call_tool("neurosiphon_repo_map", {"target_dir": f"{REPO}/apps/desktop/src"})
show(out)

# ── TEST 2: call_hierarchy (Rust) ─────────────────────────────────────────────
section("TEST 2: call_hierarchy — Rust `run_convert` in rs-smelter")
out = call_tool("neurosiphon_call_hierarchy", {
    "repoPath": REPO,
    "target_dir": "services/rs-smelter/src",
    "symbol_name": "run_convert",
})
show(out, 60)

# ── TEST 3: call_hierarchy (Python) ───────────────────────────────────────────
section("TEST 3: call_hierarchy — Python `_copy_tokenizer_extras` (KNOWN SILENT BUG)")
out = call_tool("neurosiphon_call_hierarchy", {
    "repoPath": REPO,
    "target_dir": "services/py-mlx-bridge/src",
    "symbol_name": "_copy_tokenizer_extras",
})
show(out, 60)

# ── TEST 4: find_usages (Python) ──────────────────────────────────────────────
section("TEST 4: find_usages — Python `_copy_tokenizer_extras` (should find 4)")
out = call_tool("neurosiphon_find_usages", {
    "repoPath": REPO,
    "target_dir": "services/py-mlx-bridge/src",
    "symbol_name": "_copy_tokenizer_extras",
})
show(out, 40)

# ── TEST 5: diagnostics ───────────────────────────────────────────────────────
section("TEST 5: diagnostics — rs-smelter (Rust)")
out = call_tool("neurosiphon_diagnostics", {"repoPath": f"{REPO}/services/rs-smelter"})
show(out, 20)

print("\n\nDone.")
