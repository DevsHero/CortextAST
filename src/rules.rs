//! # CortexAST — 3-Tier Rule Engine
//!
//! Implements `cortex_get_rules`: deep-merges YAML rule files from three tiers
//! (Global < Team < Project) and returns a unified JSON/YAML object.
//!
//! ## Tier resolution priority (last-write-wins for scalars; arrays are unioned)
//!  1. **Tier 1 — Global**   `~/.cortexast/global_rules.yml`
//!  2. **Tier 2 — Team**     `~/.cortexast/cluster/{team_cluster_id}_rules.yml`
//!                           (team_cluster_id sourced from `.cortexast.json` in project root)
//!  3. **Tier 3 — Project**  `{project_path}/.cortex_rules.yml`

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::path::Path;

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

fn global_rules_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".cortexast")
        .join("global_rules.yml")
}

fn cluster_rules_path(team_cluster_id: &str) -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".cortexast")
        .join("cluster")
        .join(format!("{team_cluster_id}_rules.yml"))
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML → serde_json::Value
// ─────────────────────────────────────────────────────────────────────────────

/// Parse a YAML file into `serde_json::Value`. Uses the serde_yaml → JSON-string
/// round-trip so that callers only deal with JSON types throughout.
fn read_yaml_as_json(path: &Path) -> Result<Value> {
    let content =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let yaml_val: serde_yaml::Value =
        serde_yaml::from_str(&content).with_context(|| format!("parsing {}", path.display()))?;
    // Round-trip through JSON string is safe: serde_yaml implements Serialize.
    let json_str = serde_json::to_string(&yaml_val)?;
    serde_json::from_str(&json_str).context("converting yaml→json")
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep-merge (last-write-wins for scalars; arrays are unioned without duplicates)
// ─────────────────────────────────────────────────────────────────────────────

/// Recursively merge `src` into `dst`.
///
/// - **Object/map**: keys from `src` are merged into `dst` recursively.
/// - **Array**: items from `src` are appended if not already present in `dst`
///   (union semantics; preserves insertion order, dst items first).
/// - **Scalar** (`bool`, `number`, `string`, `null`): `src` overwrites `dst`.
pub fn deep_merge(dst: &mut Value, src: Value) {
    match (dst, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (k, v) in s {
                deep_merge(d.entry(k).or_insert(Value::Null), v);
            }
        }
        (Value::Array(d), Value::Array(s)) => {
            // Union: only add items from `src` that are not already in `dst`.
            for item in s {
                if !d.contains(&item) {
                    d.push(item);
                }
            }
        }
        (dst, src) => *dst = src,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Merge all three rule tiers for the given workspace directory and return the
/// combined rules as a `serde_json::Value` (Object).
///
/// Files that do not exist are silently skipped (tier is treated as empty).
/// Parse errors emit a `[cortex_get_rules] WARN` to stderr but do not abort.
pub fn get_merged_rules(project_path: &str) -> Result<Value> {
    let mut merged: Value = Value::Object(Map::new());
    let project_dir = Path::new(project_path);

    // ── Tier 1: Global ────────────────────────────────────────────────────────
    let global_path = global_rules_path();
    load_tier_into(&mut merged, &global_path, "global_rules.yml");

    // ── Read .cortexast.json → team_cluster_id ────────────────────────────────
    let config_path = project_dir.join(".cortexast.json");
    let team_cluster_id: Option<String> = if config_path.exists() {
        read_team_cluster_id(&config_path)
    } else {
        None
    };

    // ── Tier 2: Team/cluster ──────────────────────────────────────────────────
    if let Some(ref id) = team_cluster_id {
        let cluster_path = cluster_rules_path(id);
        load_tier_into(&mut merged, &cluster_path, &format!("{id}_rules.yml"));
    }

    // ── Tier 3: Project (highest priority) ───────────────────────────────────
    let project_rules_path = project_dir.join(".cortex_rules.yml");
    load_tier_into(&mut merged, &project_rules_path, ".cortex_rules.yml");

    Ok(merged)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn load_tier_into(dst: &mut Value, path: &Path, label: &str) {
    if !path.exists() {
        return;
    }
    match read_yaml_as_json(path) {
        Ok(v) => deep_merge(dst, v),
        Err(e) => eprintln!("[cortex_get_rules] WARN: {label} parse error: {e}"),
    }
}

fn read_team_cluster_id(config_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(config_path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;
    json.get("rules_engine")
        .and_then(|r| r.get("team_cluster_id"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_yaml(dir: &std::path::Path, name: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn deep_merge_scalars_overwrite() {
        let mut base = serde_json::json!({"persona": "verbose", "strict": false});
        let overlay = serde_json::json!({"persona": "silent"});
        deep_merge(&mut base, overlay);
        assert_eq!(base["persona"], "silent");
        assert_eq!(base["strict"], false); // untouched
    }

    #[test]
    fn deep_merge_arrays_union() {
        let mut base = serde_json::json!({"banned_tools": ["rm"]});
        let overlay = serde_json::json!({"banned_tools": ["rm", "git push"]});
        deep_merge(&mut base, overlay);
        let arr = base["banned_tools"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr.contains(&serde_json::json!("rm")));
        assert!(arr.contains(&serde_json::json!("git push")));
    }

    #[test]
    fn get_merged_rules_three_tiers() {
        let tmp = TempDir::new().unwrap();
        let project_dir = tmp.path().join("workspace_b");
        std::fs::create_dir_all(&project_dir).unwrap();

        // Simulate with inline yaml files in tmp (we'll call read_yaml_as_json directly)
        let t1_path = write_yaml(
            tmp.path(),
            "global_rules.yml",
            r#"{"banned_tools": ["rm"], "persona": "verbose"}"#,
        );
        let t2_path = write_yaml(
            tmp.path(),
            "team_rules.yml",
            r#"{"banned_tools": ["rm", "git push"], "require_tests": true}"#,
        );
        let t3_path = write_yaml(
            tmp.path(),
            "project_rules.yml",
            r#"{"persona": "silent", "vision_model": "mlx"}"#,
        );

        let mut merged = Value::Object(Map::new());
        load_tier_into(&mut merged, &t1_path, "global");
        load_tier_into(&mut merged, &t2_path, "team");
        load_tier_into(&mut merged, &t3_path, "project");

        assert_eq!(merged["persona"], "silent"); // project overrides global
        let banned = merged["banned_tools"].as_array().unwrap();
        assert_eq!(banned.len(), 2); // union of ["rm"] + ["rm","git push"]
        assert!(merged.get("require_tests").is_some());
        assert_eq!(merged["vision_model"], "mlx");
    }
}
