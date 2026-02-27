//! Surgical byte-level patcher for structured data files and Markdown.
//!
//! This is the "God Hand" implementation for `cortex_act_edit_markup` and
//! `cortex_act_edit_data_graph`.  It uses the `TreeSitterEngine` AST pipeline
//! to locate the **exact byte range** of a target node, then reconstructs the
//! file as:
//!
//!   raw[..start_byte]  +  new_bytes  +  raw[end_byte..]
//!
//! Every byte outside the target — comments, blank lines, indentation — is
//! left completely untouched.
//!
//! ## Supported formats
//!
//! | Extension | Target syntax | Notes |
//! |-----------|--------------|-------|
//! | `.json`   | `"servers.0.host"` dot-path | |
//! | `.yaml` / `.yml` | `"database.port"` dot-path | |
//! | `.toml`   | `"dependencies.serde"` dot-path | |
//! | `.md` / `.markdown` | `"heading:Setup"` or bare heading text | |
//!
//! For JSON/YAML/TOML the **VALUE** node bytes are replaced.
//! For Markdown the **section body** bytes (between heading and next
//! same-level heading) are replaced.
//!
//! ## Fallback hierarchy
//!
//! 1. `TreeSitterEngine::find_node_bytes` — comment-preserving byte-splice
//! 2. Docs-patcher line scan (Markdown only, when grammar not loaded)
//! 3. serde round-trip with `⚠ comment-loss` warning (JSON/YAML/TOML only)

use anyhow::{bail, Context, Result};
use std::path::Path;

use crate::data_engine::tree_sitter_engine::TreeSitterEngine;

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/// Surgically edit a structured data file (JSON / YAML / TOML) or a Markdown
/// section body using tree-sitter byte-ranges.
///
/// `action` is `"set"` / `"replace"` (synonyms) or `"delete"`.
/// `target` is a dot-path for data files or a heading text for Markdown.
/// `code` is the replacement content (ignored for `"delete"`).
///
/// Returns a human-readable status string.
pub fn patch_markup(
    file: &str,
    target: &str,
    action: &str,
    code: &str,
) -> Result<String> {
    let path = Path::new(file);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    check_write_permission(path)?;

    match ext.as_str() {
        "json" | "yaml" | "yml" | "toml" => {
            patch_data_file(file, path, &ext, target, action, code)
        }
        "md" | "markdown" => patch_markdown(file, path, target, action, code),
        other => bail!(
            "cortex_act_edit_markup: unsupported file type '.{other}'. \
             Supported: json, yaml, yml, toml, md, markdown"
        ),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data-file path (JSON / YAML / TOML)
// ─────────────────────────────────────────────────────────────────────────────

fn patch_data_file(
    file: &str,
    path: &Path,
    ext: &str,
    dot_path: &str,
    action: &str,
    code: &str,
) -> Result<String> {
    // ── 1.  Surgical path (tree-sitter byte-splice) ───────────────────────
    if matches!(action, "set" | "replace") {
        if let Ok(Some((start, end))) = TreeSitterEngine::find_node_bytes(path, dot_path) {
            return splice_and_validate(file, path, start, end, code, dot_path, false);
        }
    }
    if action == "delete" {
        if let Ok(Some((start, end))) = TreeSitterEngine::find_node_bytes(path, dot_path) {
            // For delete we also need to eat the surrounding key + punctuation.
            // Floor-plan: extend start backwards to consume the key text.
            let raw = std::fs::read(file).context("Reading file for delete")?;
            let extended_start = find_key_start(&raw, start, dot_path);
            return splice_and_validate(file, path, extended_start, end, "", dot_path, false);
        }
    }

    // ── 2.  serde fallback — grammar not loaded ───────────────────────────
    crate::act::config_patcher::patch_config(
        file,
        action,
        dot_path,
        Some(
            &serde_json::from_str(code)
                .unwrap_or(serde_json::Value::String(code.to_owned())),
        ),
    )
    .with_context(|| {
        format!(
            "(serde fallback for .{ext}) \
             Load grammar to preserve comments: \
             cortex_manage_ast_languages(action:\"add\", languages:[\"{ext}\"])"
        )
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown path
// ─────────────────────────────────────────────────────────────────────────────

fn patch_markdown(
    file: &str,
    path: &Path,
    target: &str,
    action: &str,
    code: &str,
) -> Result<String> {
    // Strip optional "heading:" prefix so callers can use either form.
    let heading = target
        .strip_prefix("heading:")
        .unwrap_or(target)
        .trim();

    // ── 1.  Tree-sitter surgical path ─────────────────────────────────────
    if let Ok(Some((start, end))) =
        TreeSitterEngine::find_node_bytes(path, heading)
    {
        let new_bytes = match action {
            "delete" => "".to_owned(),
            _ => format!("\n{}\n\n", code.trim_end()),
        };
        return splice_and_validate(file, path, start, end, &new_bytes, heading, true);
    }

    // ── 2.  Line-scan fallback (docs_patcher) ─────────────────────────────
    if action == "delete" {
        bail!("delete action on Markdown requires tree-sitter grammar. \
               Run: cortex_manage_ast_languages(action:\"add\", languages:[\"markdown\"])");
    }
    let level = infer_heading_level(file, heading).unwrap_or(2);
    crate::act::docs_patcher::patch_docs(file, heading, code, level)
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: splice + tree-sitter validation
// ─────────────────────────────────────────────────────────────────────────────

fn splice_and_validate(
    file: &str,
    path: &Path,
    start: usize,
    end: usize,
    new_content: &str,
    target: &str,
    skip_validation: bool,  // skip for Markdown (no strict AST requirement)
) -> Result<String> {
    let raw = std::fs::read(file).context("Reading file for splice")?;
    let total = raw.len();
    if start > total || end > total || start > end {
        bail!(
            "Byte range [{start}..{end}] out of bounds for file of {total} bytes"
        );
    }

    let patched: Vec<u8> = [&raw[..start], new_content.as_bytes(), &raw[end..]].concat();

    if !skip_validation {
        // Re-parse with tree-sitter to catch structural breaks.
        let patched_str = std::str::from_utf8(&patched)
            .context("Patched content is not valid UTF-8")?;
        let cfg = crate::inspector::exported_language_config();
        let guard = cfg.read().unwrap();
        if let Some(driver) = guard.driver_for_path(path) {
            if let Ok(mut parser) = driver.make_parser(path) {
                if let Some(tree) = parser.parse(patched_str, None) {
                    if tree.root_node().has_error() {
                        bail!(
                            "Patched file failed tree-sitter validation — \
                             the replacement broke the AST at '{target}'. \
                             Aborting to preserve the original content."
                        );
                    }
                }
            }
        }
    }

    std::fs::write(file, &patched).context("Writing patched file")?;

    let delta: i64 = new_content.len() as i64 - (end - start) as i64;
    Ok(format!(
        "✅ Patched '{}' at '{}' [bytes {}..{}] \
         ({:+} bytes, comment-preserving)",
        file, target, start, end, delta
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/// Walk backwards from `value_start` to consume the key + separator so a
/// "delete" removes the whole key-value entry, not just the value.
fn find_key_start(raw: &[u8], value_start: usize, dot_path: &str) -> usize {
    let last_key = dot_path.rsplit('.').next().unwrap_or(dot_path);
    // Search for `"last_key"` (JSON-style) or `last_key` (TOML/YAML) before
    // the value position.
    let search_from = value_start.saturating_sub(last_key.len() + 10);
    let prefix = &raw[search_from..value_start];
    // Try both `"key":` and `key:` and `key =` patterns.
    for pattern in [
        format!("\"{}\":", last_key),
        format!("{}:", last_key),
        format!("{} =", last_key),
    ] {
        if let Some(pos) = find_subsequence(prefix, pattern.as_bytes()) {
            return search_from + pos;
        }
    }
    value_start // fallback: only the value
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

/// Infer the heading level (#, ##, etc.) of a section by scanning the file
/// for the heading line.
fn infer_heading_level(file: &str, heading: &str) -> Option<usize> {
    let content = std::fs::read_to_string(file).ok()?;
    for line in content.lines() {
        let trimmed = line.trim_start_matches('#');
        let level = line.len() - trimmed.len();
        if level > 0 && trimmed.trim() == heading {
            return Some(level);
        }
    }
    None
}

/// Verify the target file is writable before touching anything.
fn check_write_permission(path: &Path) -> Result<()> {
    let meta = std::fs::metadata(path)
        .with_context(|| format!("Cannot stat {:?} — file may not exist", path))?;
    if meta.permissions().readonly() {
        bail!(
            "File {:?} is read-only. Run: chmod 644 {:?}",
            path, path
        );
    }
    Ok(())
}
