//! # Phase 3 E2E Memory Test
//!
//! Writes a fixture journal with mixed Phase-1 and Phase-2 entries, exercises
//! `MemoryStore::load`, `hybrid_search`, tag filtering, and `MemoryStore::reload`.
//!
//! Run with:
//! ```
//! cargo test --test e2e_memory -- --nocapture
//! ```

use cortexast::memory::{cosine_similarity, hybrid_search, keyword_score, MemoryEntry, MemoryStore};
use std::io::Write as _;

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

fn make_entry(
    id: &str,
    intent: &str,
    decision: &str,
    tags: &[&str],
    vector: Option<Vec<f32>>,
) -> String {
    let tags_json: Vec<String> = tags.iter().map(|t| format!("\"{t}\"")).collect();
    let vec_field = match vector {
        Some(v) => format!(
            r#","vector":{}"#,
            serde_json::to_string(&v).unwrap()
        ),
        None => String::new(),
    };
    format!(
        r#"{{"schema_version":"1.0","id":"{id}","session_id":"s1","timestamp":"2026-01-01T00:00:00Z","source_ide":"cursor","project_path":"/proj","intent":"{intent}","decision":"{decision}","tool_calls":[],"files_touched":[],"tags":[{}]{}}}"#,
        tags_json.join(","),
        vec_field
    )
}

/// Build a 512-dim vector pointing strongly in a single direction.
fn vec_512(primary_dim: usize, value: f32) -> Vec<f32> {
    let mut v = vec![0.0_f32; 512];
    v[primary_dim] = value;
    v
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

/// A store loaded from a fixture JSONL must have entries and vectors of equal length.
#[test]
fn store_load_lengths_equal() {
    let mut tmp = tempfile::NamedTempFile::new().unwrap();
    writeln!(tmp, "{}", make_entry("e1", "Refactor parser", "Extracted helper fn", &["refactor"], None)).unwrap();
    writeln!(tmp, "{}", make_entry("e2", "Add new UI button", "Used React component", &["ui"], Some(vec_512(0, 1.0)))).unwrap();

    let store = MemoryStore::load(tmp.path()).unwrap();
    assert_eq!(store.entries.len(), store.vectors.len(), "parallel vec lengths must match");
    assert_eq!(store.entries.len(), 2);
    // Phase-1 entry → empty vector slot
    assert!(store.vectors[0].is_empty(), "Phase-1 entry must have empty vector slot");
    // Phase-2 entry → 512-dim slot
    assert_eq!(store.vectors[1].len(), 512, "Phase-2 entry must have 512-dim slot");
}

/// `hybrid_search` keyword-only: higher-keyword-overlap entry must rank first.
#[test]
fn hybrid_search_keyword_only_ranks_correctly() {
    let mut tmp = tempfile::NamedTempFile::new().unwrap();
    for (id, intent, decision, tags) in [
        ("best",  "refactor the parser module logic",    "split into smaller functions", &["refactor"][..]),
        ("mid",   "refactor a single helper",            "moved to utils.rs",           &["refactor"]),
        ("worst", "add a button to the dashboard",       "used React state",            &["ui"]),
    ] {
        writeln!(tmp, "{}", make_entry(id, intent, decision, tags, None)).unwrap();
    }

    let store = MemoryStore::load(tmp.path()).unwrap();
    let tokens = ["refactor", "parser", "module"];
    let results = hybrid_search(&store, None, &tokens, 3, &[]);

    // Print for --nocapture visibility
    println!("\nhybrid_search_keyword_only_ranks_correctly:");
    for r in &results {
        println!("  #{} id={} score={:.4} intent={}", results.iter().position(|x| std::ptr::eq(x, r)).unwrap() + 1, r.entry.id, r.score, r.entry.intent);
    }

    assert_eq!(results[0].entry.id, "best", "entry with most keyword overlap must rank first");
    assert!(results[0].score > results[2].score, "rank-1 score must exceed rank-3");
}

/// `hybrid_search` with Phase-2 vectors: the semantically close entry ranks first.
#[test]
fn hybrid_search_vector_boosts_relevant_entry() {
    // Two entries with identical keyword coverage but different vectors.
    // query_vec points to dim 0; "relevant" entry's vector also points to dim 0.
    let relevant_vec = vec_512(0, 1.0);
    let irrelevant_vec = vec_512(1, 1.0); // orthogonal to query

    let mut tmp = tempfile::NamedTempFile::new().unwrap();
    writeln!(tmp, "{}", make_entry("relevant", "refactor parser", "split fn", &["refactor"], Some(relevant_vec.clone()))).unwrap();
    writeln!(tmp, "{}", make_entry("irrelevant", "refactor parser", "split fn", &["refactor"], Some(irrelevant_vec))).unwrap();

    let store = MemoryStore::load(tmp.path()).unwrap();
    let query_vec = relevant_vec; // query points to same dim as "relevant"
    let tokens = ["refactor"];
    let results = hybrid_search(&store, Some(&query_vec), &tokens, 5, &[]);

    println!("\nhybrid_search_vector_boosts_relevant_entry:");
    for r in &results {
        println!("  id={} score={:.4}", r.entry.id, r.score);
    }

    assert_eq!(results[0].entry.id, "relevant", "semantically aligned entry must rank first");
    assert!(results[0].score > results[1].score, "cosine boost must produce higher score");
}

/// Tag filter must exclude entries whose tags don't match.
#[test]
fn hybrid_search_tag_filter_excludes_non_matching() {
    let mut tmp = tempfile::NamedTempFile::new().unwrap();
    writeln!(tmp, "{}", make_entry("a", "fix auth bug", "patched token verification", &["bugfix"], None)).unwrap();
    writeln!(tmp, "{}", make_entry("b", "fix auth bug", "patched token verification", &["refactor"], None)).unwrap();
    writeln!(tmp, "{}", make_entry("c", "fix auth bug", "patched token verification", &["bugfix", "security"], None)).unwrap();

    let store = MemoryStore::load(tmp.path()).unwrap();
    let results = hybrid_search(&store, None, &["fix"], 10, &["bugfix".to_string()]);

    let ids: Vec<&str> = results.iter().map(|r| r.entry.id.as_str()).collect();
    println!("\nhybrid_search_tag_filter: ids={ids:?}");

    assert!(ids.contains(&"a"), "entry 'a' has 'bugfix'");
    assert!(!ids.contains(&"b"), "entry 'b' lacks 'bugfix' — must be excluded");
    assert!(ids.contains(&"c"), "entry 'c' has 'bugfix'");
}

/// `MemoryStore::reload` must return false when the file hasn't changed.
#[test]
fn memory_store_reload_no_change() {
    let mut tmp = tempfile::NamedTempFile::new().unwrap();
    writeln!(tmp, "{}", make_entry("e1", "intent", "decision", &[], None)).unwrap();

    let mut store = MemoryStore::load(tmp.path()).unwrap();
    // Without touching the file the mtime won't change → reload returns false.
    assert!(!store.reload(), "reload must return false on unchanged file");
}

/// `cosine_similarity` is symmetric and bounded.
#[test]
fn cosine_similarity_properties() {
    let a = vec_512(0, 1.0);
    let b = vec_512(1, 1.0);
    let c = vec_512(0, 1.0);

    // Orthogonal → ~0
    let ortho = cosine_similarity(&a, &b);
    assert!(ortho.abs() < 1e-5, "orthogonal vectors: cos≈0, got {ortho}");

    // Identical → 1
    let same = cosine_similarity(&a, &c);
    assert!((same - 1.0).abs() < 1e-5, "identical vectors: cos=1, got {same}");

    // Symmetric
    assert!((cosine_similarity(&a, &b) - cosine_similarity(&b, &a)).abs() < 1e-6, "symmetry");
}

/// `keyword_score` returns 0.0 for empty tokens regardless of entry content.
#[test]
fn keyword_score_empty_tokens_returns_zero() {
    let entry: MemoryEntry = serde_json::from_str(
        r#"{"schema_version":"1.0","id":"x","session_id":"s","timestamp":"2026-01-01T00:00:00Z","source_ide":"cursor","project_path":"/p","intent":"lots of content here","decision":"also content","tool_calls":[],"files_touched":[],"tags":["refactor"]}"#
    ).unwrap();
    assert_eq!(keyword_score(&entry, &[]), 0.0);
}

/// Full end-to-end scenario: 5-entry journal, Phase-1 + Phase-2 mixed.
#[test]
fn e2e_mixed_journal_top_k_respected() {
    let entries_raw = vec![
        make_entry("id-r1", "Refactor the auth service completely", "Split into handler and service layers", &["refactor", "auth"], Some(vec_512(0, 0.9))),
        make_entry("id-r2", "Refactor the parser", "Extracted helper functions", &["refactor"], Some(vec_512(0, 0.7))),
        make_entry("id-u1", "Add UI loading spinner", "Used React Suspense", &["ui"], Some(vec_512(2, 1.0))),
        make_entry("id-u2", "Fix CSS alignment", "Updated flexbox rules", &["ui", "css"], None),
        make_entry("id-d1", "Update docs for API", "Added JSDoc comments", &["docs"], None),
    ];

    let mut tmp = tempfile::NamedTempFile::new().unwrap();
    for line in &entries_raw {
        writeln!(tmp, "{line}").unwrap();
    }

    let store = MemoryStore::load(tmp.path()).unwrap();
    assert_eq!(store.entries.len(), 5, "all 5 entries loaded");

    // Query semantically close to refactoring, with query_vec pointing dim 0.
    let query_vec = vec_512(0, 1.0);
    let tokens = ["refactor", "auth"];
    let results = hybrid_search(&store, Some(&query_vec), &tokens, 3, &[]);

    println!("\ne2e_mixed_journal_top_k_respected:");
    for (i, r) in results.iter().enumerate() {
        println!("  #{} id={} score={:.4} intent={}", i + 1, r.entry.id, r.score, r.entry.intent);
    }

    assert_eq!(results.len(), 3, "top_k=3 must return exactly 3 results");
    // The highest-scoring entry must be a refactor/auth entry (both keyword + vector signal).
    let top_id = results[0].entry.id.as_str();
    assert!(
        top_id == "id-r1" || top_id == "id-r2",
        "rank-1 must be a refactor entry, got: {top_id}"
    );
}
