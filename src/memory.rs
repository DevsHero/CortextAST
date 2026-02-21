//! # CortexAST — Memory Entry Reader (Phase 3)
//!
//! Deserializes `MemoryEntry` records written by the `CortexSync` daemon into
//! `~/.cortexast/global_memory.jsonl`.
//!
//! ## Schema contract (CortexSync schema_version "1.0")
//!
//! ```text
//! schema_version  : String              "1.0"
//! id              : String (UUID v4)    per-entry unique ID
//! session_id      : String (UUID v4)    per-session ID
//! timestamp       : String (RFC3339)    UTC nanoseconds
//! source_ide      : String              "cursor" | "windsurf" | "vscode" | "unknown"
//! project_path    : String              absolute workspace path
//! intent          : String              ≤250 chars
//! decision        : String              ≤250 chars
//! tool_calls      : Vec<String>         MCP/IDE tool names
//! files_touched   : Vec<String>         relative or absolute paths
//! tags            : Vec<String>         e.g. ["refactor", "bugfix"]
//! vector          : Option<Vec<f32>>    512-dim; absent when CortexSync ran Phase 1
//! ```

use anyhow::{Context, Result};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

// ─────────────────────────────────────────────────────────────────────────────
// Schema structs
// ─────────────────────────────────────────────────────────────────────────────

/// A single memory record written by CortexSync.
///
/// UUIDs and timestamps are kept as `String` — CortexAST never needs to
/// compare or sort them as typed values; treating them as opaque IDs keeps
/// the dependency surface minimal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    /// Schema version tag (currently `"1.0"`).
    pub schema_version: String,
    /// Per-entry UUID v4 (opaque string).
    pub id: String,
    /// Per-session UUID v4 shared across all entries in one daemon run.
    pub session_id: String,
    /// RFC3339 UTC timestamp of when the entry was captured.
    pub timestamp: String,
    /// IDE that generated the conversation (`"cursor"`, `"vscode"`, …).
    pub source_ide: String,
    /// Absolute path of the project being observed.
    pub project_path: String,
    /// Distilled user intent (≤ 250 chars).
    pub intent: String,
    /// Distilled agent decision (≤ 250 chars).
    pub decision: String,
    /// MCP / IDE tool names invoked in this turn.
    #[serde(default)]
    pub tool_calls: Vec<String>,
    /// Paths of files created or modified.
    #[serde(default)]
    pub files_touched: Vec<String>,
    /// Semantic tags inferred by the parser (e.g. `"refactor"`, `"test"`).
    #[serde(default)]
    pub tags: Vec<String>,
    /// 512-dim embedding vector (absent for Phase-1 entries without vectorization).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vector: Option<Vec<f32>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Default journal path
// ─────────────────────────────────────────────────────────────────────────────

/// Return the default path where CortexSync writes its journal.
/// Mirrors CortexSync's `writer::default_output_path()`.
pub fn default_journal_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".cortexast")
        .join("global_memory.jsonl")
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

/// Load all `MemoryEntry` records from a JSONL file into a `Vec`.
///
/// Lines that fail to deserialize are silently skipped (forward-compatible
/// with future schema additions).
pub fn load_journal(path: &Path) -> Result<Vec<MemoryEntry>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("Cannot read journal: {}", path.display()))?;

    let entries: Vec<MemoryEntry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<MemoryEntry>(line).ok())
        .collect();

    Ok(entries)
}

/// Load the journal from the default path (`~/.cortexast/global_memory.jsonl`).
/// Returns an empty `Vec` if the file does not yet exist.
pub fn load_default_journal() -> Vec<MemoryEntry> {
    let path = default_journal_path();
    if !path.exists() {
        return Vec::new();
    }
    load_journal(&path).unwrap_or_default()
}

// ─────────────────────────────────────────────────────────────────────────────
// MemoryStore — indexed cache over a JSONL journal
// ─────────────────────────────────────────────────────────────────────────────

/// Indexed view of a JSONL journal.
///
/// Keeps a parallel `vectors` Vec so the hot-path search never needs to
/// re-clone vectors out of `MemoryEntry`.  Phase-1 entries (no vector) get an
/// empty `Vec<f32>` in the parallel slot and fall back to keyword-only scoring.
pub struct MemoryStore {
    pub entries: Vec<MemoryEntry>,
    /// Parallel to `entries`. Empty `Vec` for Phase-1 entries without embedding.
    pub vectors: Vec<Vec<f32>>,
    path: PathBuf,
    mtime: Option<SystemTime>,
}

impl MemoryStore {
    /// Load (or construct an empty store if the file does not exist yet).
    pub fn load(path: &Path) -> Result<Self> {
        let entries = load_journal(path)?;
        let mtime = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        let vectors: Vec<Vec<f32>> = entries
            .iter()
            .map(|e| e.vector.clone().unwrap_or_default())
            .collect();
        Ok(Self {
            entries,
            vectors,
            path: path.to_path_buf(),
            mtime,
        })
    }

    /// Load from the default journal path (`~/.cortexast/global_memory.jsonl`).
    /// Returns an empty store if the file does not yet exist.
    pub fn from_default() -> Self {
        let path = default_journal_path();
        if path.exists() {
            Self::load(&path).unwrap_or_else(|_| Self {
                entries: Vec::new(),
                vectors: Vec::new(),
                path,
                mtime: None,
            })
        } else {
            Self {
                entries: Vec::new(),
                vectors: Vec::new(),
                path,
                mtime: None,
            }
        }
    }

    /// Re-reads the journal if the file mtime has changed.
    ///
    /// Returns `true` when the store was reloaded, `false` when unchanged.
    pub fn reload(&mut self) -> bool {
        let current = std::fs::metadata(&self.path)
            .ok()
            .and_then(|m| m.modified().ok());
        if current == self.mtime {
            return false;
        }
        if let Ok(fresh) = Self::load(&self.path) {
            self.entries = fresh.entries;
            self.vectors = fresh.vectors;
            self.mtime = fresh.mtime;
            return true;
        }
        false
    }

    /// Slice of loaded entries.
    pub fn entries(&self) -> &[MemoryEntry] {
        &self.entries
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search primitives
// ─────────────────────────────────────────────────────────────────────────────

/// Cosine similarity in the range `[−1, 1]`.
///
/// Returns `0.0` when either vector is empty or has zero magnitude.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let mag_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let mag_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if mag_a == 0.0 || mag_b == 0.0 {
        0.0
    } else {
        (dot / (mag_a * mag_b)).clamp(-1.0, 1.0)
    }
}

/// Fraction of `tokens` that appear (case-insensitive) in the entry's
/// searchable text (`intent` + `decision` + `tags`).
///
/// Returns `0.0` when `tokens` is empty.
pub fn keyword_score(entry: &MemoryEntry, tokens: &[&str]) -> f32 {
    if tokens.is_empty() {
        return 0.0;
    }
    let text = format!(
        "{} {} {}",
        entry.intent.to_lowercase(),
        entry.decision.to_lowercase(),
        entry.tags.join(" ").to_lowercase()
    );
    let matched = tokens
        .iter()
        .filter(|t| text.contains(&t.to_lowercase()))
        .count();
    matched as f32 / tokens.len() as f32
}

/// A `MemoryEntry` paired with its relevance score.
pub struct RankedEntry {
    pub entry: MemoryEntry,
    pub score: f32,
}

/// Hybrid search over a `MemoryStore`.
///
/// Scoring:
/// - Phase-2 entry (has vector) **and** `query_vec` provided → `0.7 × cosine + 0.3 × keyword`
/// - Otherwise → keyword score only
///
/// `tag_filter`: when non-empty only entries that contain **at least one** of the
/// specified tags (case-insensitive) are considered.
///
/// Uses `rayon` to parallelise per-entry score computation.
pub fn hybrid_search(
    store: &MemoryStore,
    query_vec: Option<&[f32]>,
    tokens: &[&str],
    top_k: usize,
    tag_filter: &[String],
) -> Vec<RankedEntry> {
    let indices: Vec<usize> = if tag_filter.is_empty() {
        (0..store.entries.len()).collect()
    } else {
        (0..store.entries.len())
            .filter(|&i| {
                store.entries[i]
                    .tags
                    .iter()
                    .any(|t| tag_filter.iter().any(|f| f.eq_ignore_ascii_case(t)))
            })
            .collect()
    };

    let mut ranked: Vec<RankedEntry> = indices
        .par_iter()
        .map(|&i| {
            let entry = &store.entries[i];
            let vec = &store.vectors[i];
            let kscore = keyword_score(entry, tokens);
            let score = match (query_vec, vec.is_empty()) {
                (Some(qv), false) => 0.7 * cosine_similarity(qv, vec) + 0.3 * kscore,
                _ => kscore,
            };
            RankedEntry {
                entry: entry.clone(),
                score,
            }
        })
        .collect();

    ranked.sort_unstable_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked.truncate(top_k);
    ranked
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const PHASE1_LINE: &str = r#"{"schema_version":"1.0","id":"46d7e127-7f93-475d-89a9-3d9687c25d70","session_id":"02637a0e-8219-43b2-8764-e4d75112f4d3","timestamp":"2026-02-21T08:20:26.068339Z","source_ide":"unknown","project_path":"/tmp/test_watch","intent":"User asked to refactor parser.","decision":"Using regex extraction for tool calls.","tool_calls":["create_file","replace_string_in_file"],"files_touched":["src/parser.rs","src/schema.rs"],"tags":["file-edit","schema"]}"#;

    /// Phase 1 entry (no vector field) must deserialize correctly.
    #[test]
    fn deserializes_phase1_entry_no_vector() {
        let entry: MemoryEntry =
            serde_json::from_str(PHASE1_LINE).expect("deserialize Phase 1 entry");

        assert_eq!(entry.schema_version, "1.0");
        assert_eq!(entry.source_ide, "unknown");
        assert_eq!(entry.tool_calls, vec!["create_file", "replace_string_in_file"]);
        assert_eq!(entry.files_touched, vec!["src/parser.rs", "src/schema.rs"]);
        assert_eq!(entry.tags, vec!["file-edit", "schema"]);
        assert!(entry.vector.is_none(), "Phase 1 entries must have no vector");
    }

    /// Phase 2 entry with a vector field must deserialize and preserve dim.
    #[test]
    fn deserializes_phase2_entry_with_vector() {
        let v: Vec<f32> = vec![0.1, -0.2, 0.3];
        let json = format!(
            r#"{{"schema_version":"1.0","id":"aaaabbbb-0000-0000-0000-000000000001","session_id":"aaaabbbb-0000-0000-0000-000000000002","timestamp":"2026-02-21T09:00:00Z","source_ide":"cursor","project_path":"/proj","intent":"test","decision":"test","tool_calls":[],"files_touched":[],"tags":[],"vector":{}}}"#,
            serde_json::to_string(&v).unwrap()
        );

        let entry: MemoryEntry = serde_json::from_str(&json).expect("deserialize Phase 2 entry");
        let got = entry.vector.expect("Phase 2 entry must have vector");
        assert_eq!(got, v);
    }

    /// `load_journal` on a temp JSONL file must return the correct count.
    #[test]
    fn load_journal_counts_entries() {
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(tmp, "{PHASE1_LINE}").expect("write line 1");
        writeln!(tmp, "{PHASE1_LINE}").expect("write line 2");
        writeln!(tmp, "{{bad json}}").expect("write bad line");

        let entries = load_journal(tmp.path()).expect("load journal");
        assert_eq!(entries.len(), 2, "Bad lines must be silently skipped");
    }

    /// `MemoryStore::load` must set `entries` and `vectors` with equal length.
    #[test]
    fn memory_store_loads_and_vectors_parallel() {
        use std::io::Write;
        let v: Vec<f32> = vec![0.1_f32; 3];
        let phase2 = format!(
            r#"{{"schema_version":"1.0","id":"aaaa-0001","session_id":"ssss-0001","timestamp":"2026-01-01T00:00:00Z","source_ide":"cursor","project_path":"/proj","intent":"test","decision":"ok","tool_calls":[],"files_touched":[],"tags":[],"vector":{}}}"#,
            serde_json::to_string(&v).unwrap()
        );

        let mut tmp = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(tmp, "{PHASE1_LINE}").expect("phase1 line");
        writeln!(tmp, "{}", phase2).expect("phase2 line");

        let store = MemoryStore::load(tmp.path()).expect("load store");
        assert_eq!(store.entries.len(), store.vectors.len(), "parallel vecs must have equal len");
        assert_eq!(store.entries.len(), 2);
        // Phase-1 entry has no vector → empty slot
        assert!(store.vectors[0].is_empty(), "Phase-1 slot must be empty");
        // Phase-2 entry has vector
        assert_eq!(store.vectors[1].len(), 3, "Phase-2 slot must have 3 dims");
    }

    /// `cosine_similarity` must return 1.0 for identical non-zero vectors.
    #[test]
    fn cosine_similarity_identical_vectors() {
        let a = vec![1.0_f32, 2.0, 3.0];
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-5);
    }

    /// `cosine_similarity` must return 0.0 for empty input.
    #[test]
    fn cosine_similarity_empty_returns_zero() {
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
    }

    /// `keyword_score` with all tokens present must return 1.0.
    #[test]
    fn keyword_score_full_match() {
        let entry: MemoryEntry = serde_json::from_str(PHASE1_LINE).unwrap();
        // "refactor" appears in `entry.intent`
        let score = keyword_score(&entry, &["refactor"]);
        assert!((score - 1.0).abs() < 1e-6, "all tokens found → score 1.0");
    }

    /// `hybrid_search` must rank the semantically closest entry first.
    #[test]
    fn hybrid_search_keyword_ranking() {
        use std::io::Write;

        let no_vec_refactor = r#"{"schema_version":"1.0","id":"id-1","session_id":"s1","timestamp":"2026-01-01T00:00:00Z","source_ide":"cursor","project_path":"/proj","intent":"refactor the parser module","decision":"extract helper","tool_calls":[],"files_touched":[],"tags":["refactor"]}"#;
        let no_vec_unrelated = r#"{"schema_version":"1.0","id":"id-2","session_id":"s1","timestamp":"2026-01-01T00:00:01Z","source_ide":"cursor","project_path":"/proj","intent":"add new UI button","decision":"used React component","tool_calls":[],"files_touched":[],"tags":["ui"]}"#;

        let mut tmp = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(tmp, "{no_vec_refactor}").unwrap();
        writeln!(tmp, "{no_vec_unrelated}").unwrap();

        let store = MemoryStore::load(tmp.path()).expect("store");
        let tokens = ["refactor", "parser"];
        let results = hybrid_search(&store, None, &tokens, 5, &[]);

        assert!(!results.is_empty(), "must return results");
        assert_eq!(
            results[0].entry.id, "id-1",
            "refactor entry must rank first"
        );
    }

    /// `hybrid_search` with `tag_filter` must exclude non-matching entries.
    #[test]
    fn hybrid_search_tag_filter() {
        use std::io::Write;
        let tagged = r#"{"schema_version":"1.0","id":"id-tagged","session_id":"s1","timestamp":"2026-01-01T00:00:00Z","source_ide":"cursor","project_path":"/proj","intent":"fix the bug","decision":"found root cause","tool_calls":[],"files_touched":[],"tags":["bugfix"]}"#;
        let other  = r#"{"schema_version":"1.0","id":"id-other","session_id":"s1","timestamp":"2026-01-01T00:00:01Z","source_ide":"cursor","project_path":"/proj","intent":"fix the bug","decision":"found root cause","tool_calls":[],"files_touched":[],"tags":["refactor"]}"#;

        let mut tmp = tempfile::NamedTempFile::new().expect("temp file");
        writeln!(tmp, "{tagged}").unwrap();
        writeln!(tmp, "{other}").unwrap();

        let store = MemoryStore::load(tmp.path()).expect("store");
        let results = hybrid_search(&store, None, &["fix"], 10, &["bugfix".to_string()]);

        assert_eq!(results.len(), 1, "only one entry has tag 'bugfix'");
        assert_eq!(results[0].entry.id, "id-tagged");
    }
}
