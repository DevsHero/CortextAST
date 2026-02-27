//! Workflow automation tools for the CortexAct execution engine.
//!
//! ## `cortex_act_batch_execute`
//!
//! Sends an array of edit operations in a single tool call.  Each operation
//! maps a `tool_name` to its parameters.  Results are collected regardless of
//! individual failures — a single failing op does not abort the rest.
//!
//! ```json
//! {
//!   "operations": [
//!     { "tool_name": "cortex_act_edit_data_graph",
//!       "parameters": { "file": "Cargo.toml", "target": "package.version",
//!                       "action": "set", "value": "2.2.0" } },
//!     { "tool_name": "cortex_act_edit_markup",
//!       "parameters": { "file": "CHANGELOG.md", "target": "heading:Unreleased",
//!                       "action": "replace",
//!                       "code": "## [2.2.0] — 2026-03-01\n…" } }
//!   ]
//! }
//! ```
//!
//! ## `cortex_act_shell_exec`
//!
//! Synchronous shell execution with a hard timeout (default 10 s).  Returns
//! stdout, stderr, and exit code.  Suitable for short commands like `git diff`,
//! `ls`, `cargo check`, `jq`; use `cortex_act_run_async` for long builds.

use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::{Duration, Instant};

// ─────────────────────────────────────────────────────────────────────────────
// batch_execute
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct OpResult {
    pub index: usize,
    pub tool_name: String,
    pub success: bool,
    pub message: String,
}

/// Execute an ordered list of CortexAct operations, collecting individual
/// results.  Failures are reported per-operation; the batch always completes.
pub fn batch_execute(operations: &[Value]) -> Vec<OpResult> {
    operations
        .iter()
        .enumerate()
        .map(|(i, op)| dispatch_op(i, op))
        .collect()
}

fn dispatch_op(index: usize, op: &Value) -> OpResult {
    let tool_name = op
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let params = op.get("parameters").cloned().unwrap_or(json!({}));

    let result = run_op(&tool_name, &params);
    match result {
        Ok(msg) => OpResult {
            index,
            tool_name,
            success: true,
            message: msg,
        },
        Err(e) => OpResult {
            index,
            tool_name,
            success: false,
            message: format!("❌ {:#}", e),
        },
    }
}

/// Map tool_name → actual Rust function call.
fn run_op(tool_name: &str, params: &Value) -> Result<String> {
    match tool_name {
        // ── Markup / data-graph patcher ───────────────────────────────────
        "cortex_act_edit_markup" | "cortex_act_edit_data_graph" => {
            let file = require_str(params, "file")?;
            let target = require_str(params, "target")?;
            let action = params
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("set");
            let code = params
                .get("code")
                .or_else(|| params.get("value"))
                .and_then(|v| {
                    if v.is_string() {
                        v.as_str().map(|s| s.to_owned())
                    } else {
                        Some(v.to_string())
                    }
                })
                .unwrap_or_default();
            crate::act::markup_patcher::patch_markup(file, target, action, &code)
        }

        // ── Source-code AST patcher ───────────────────────────────────────
        "cortex_act_edit_ast" => {
            let file = require_str(params, "file")?;
            let path = std::path::Path::new(file);
            let edits_json = params
                .get("edits")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let llm_url = params.get("llm_url").and_then(|v| v.as_str());

            let edits: Vec<crate::act::editor::AstEdit> = edits_json
                .iter()
                .filter_map(|e| {
                    Some(crate::act::editor::AstEdit {
                        target: e.get("target")?.as_str()?.to_owned(),
                        action: e
                            .get("action")
                            .and_then(|v| v.as_str())
                            .unwrap_or("replace")
                            .to_owned(),
                        code: e
                            .get("code")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_owned(),
                    })
                })
                .collect();

            if edits.is_empty() {
                bail!("No valid edits provided for cortex_act_edit_ast");
            }
            let new_source =
                crate::act::editor::apply_ast_edits(path, edits, llm_url)?;
            Ok(format!(
                "✅ Applied AST edits to '{}' ({} chars)",
                file,
                new_source.len()
            ))
        }

        // ── Config / env patcher ──────────────────────────────────────────
        "cortex_patch_file" => {
            let file = require_str(params, "file")?;
            let kind = params
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("config");
            let target = require_str(params, "target")?;
            let action = params
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("set");
            let value_raw = params.get("value").cloned();

            match kind {
                "config" => crate::act::config_patcher::patch_config(
                    file,
                    action,
                    target,
                    value_raw.as_ref(),
                ),
                "docs" => {
                    let level = params
                        .get("heading_level")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(2) as usize;
                    let content = value_raw
                        .as_ref()
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    crate::act::docs_patcher::patch_docs(file, target, content, level)
                }
                "env" => {
                    let value = value_raw
                        .as_ref()
                        .and_then(|v| v.as_str());
                    crate::act::env_patcher::patch_env(file, action, target, value)
                }
                other => bail!("Unknown cortex_patch_file type: {other}"),
            }
        }

        // ── Async job (fire-and-forget within batch) ──────────────────────
        "cortex_act_run_async" => {
            let command = require_str(params, "command")?;
            let cwd = params.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_owned());
            let timeout_secs = params
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(300);
            let job_id =
                crate::act::job_manager::spawn_job(command.to_owned(), cwd, timeout_secs)?.job_id;
            Ok(format!("🚀 Async job started: {job_id}"))
        }

        // ── Shell exec within batch ───────────────────────────────────────
        "cortex_act_shell_exec" => {
            let command = require_str(params, "command")?;
            let cwd = params.get("cwd").and_then(|v| v.as_str());
            let timeout = params
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(10);
            let r = shell_exec(command, cwd, timeout)?;
            Ok(format!(
                "exit:{} | {}ms\n--- stdout ---\n{}\n--- stderr ---\n{}",
                r.exit_code, r.duration_ms, r.stdout.trim_end(), r.stderr.trim_end()
            ))
        }

        other => bail!("cortex_act_batch_execute: unknown tool '{other}'"),
    }
}

fn require_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("Missing required parameter: '{key}'"))
}

/// Format batch results as a human-readable summary.
pub fn format_batch_results(results: &[OpResult]) -> String {
    let total = results.len();
    let passed = results.iter().filter(|r| r.success).count();
    let failed = total - passed;

    let mut out = format!(
        "# Batch Execution Summary — {passed}/{total} succeeded\n\n"
    );
    for r in results {
        let icon = if r.success { "✅" } else { "❌" };
        out.push_str(&format!(
            "{icon} [{}] {}: {}\n",
            r.index + 1,
            r.tool_name,
            r.message
        ));
    }
    if failed > 0 {
        out.push_str(&format!("\n⚠ {failed} operation(s) failed — see above for details.\n"));
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// shell_exec
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct ShellResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// Execute a shell command synchronously with a hard timeout.
///
/// On timeout: the child process is sent SIGTERM, then the function returns
/// an error.  Use `cortex_act_run_async` for long-running processes.
pub fn shell_exec(
    command: &str,
    cwd: Option<&str>,
    timeout_secs: u64,
) -> Result<ShellResult> {
    let start = Instant::now();

    let mut cmd = std::process::Command::new("sh");
    cmd.args(["-c", command]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let child = cmd.spawn().map_err(|e| {
        anyhow::anyhow!("Failed to spawn command `{}`: {}", command, e)
    })?;
    let pid = child.id();

    // Move child into a background thread for blocking wait_with_output().
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<std::process::Output>>();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    let timeout = Duration::from_secs(timeout_secs);
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(ShellResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            duration_ms: start.elapsed().as_millis() as u64,
        }),
        Ok(Err(e)) => Err(e.into()),
        Err(_timeout) => {
            // Child is still running inside the thread — terminate it.
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
            bail!(
                "Command timed out after {timeout_secs}s: `{command}`"
            )
        }
    }
}
