use crate::config::Config;
use crate::scanner::{scan_workspace, ScanOptions};
use crate::xml_builder::build_context_xml;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SliceMeta {
    pub repo_root: PathBuf,
    pub target: PathBuf,
    pub budget_tokens: usize,
    pub total_tokens: usize,
    pub total_files: usize,
    pub total_bytes: u64,
}

pub fn estimate_tokens_from_bytes(total_bytes: u64, chars_per_token: usize) -> usize {
    if chars_per_token == 0 {
        return total_bytes as usize;
    }

    // Heuristic: ~4 chars per token. We use bytes as a proxy for chars.
    ((total_bytes as f64) / (chars_per_token as f64)).ceil() as usize
}

pub fn slice_to_xml(repo_root: &Path, target: &Path, budget_tokens: usize, cfg: &Config) -> Result<(String, SliceMeta)> {
    let opts = ScanOptions {
        repo_root: repo_root.to_path_buf(),
        target: target.to_path_buf(),
        max_file_bytes: cfg.token_estimator.max_file_bytes,
        exclude_dir_names: vec![
            ".git".into(),
            "node_modules".into(),
            "dist".into(),
            "target".into(),
            cfg.output_dir.to_string_lossy().to_string(),
        ],
    };

    let entries = scan_workspace(&opts)?;

    // Greedy fit by path order: include files until budget reached.
    let mut picked = Vec::new();
    let mut total_bytes = 0u64;
    for e in entries {
        let new_total = total_bytes.saturating_add(e.bytes);
        let est = estimate_tokens_from_bytes(new_total, cfg.token_estimator.chars_per_token);
        if est > budget_tokens {
            continue;
        }
        total_bytes = new_total;
        picked.push(e);
    }

    let total_tokens = estimate_tokens_from_bytes(total_bytes, cfg.token_estimator.chars_per_token);

    let mut files_for_xml = Vec::with_capacity(picked.len());
    for e in &picked {
        let bytes = std::fs::read(&e.abs_path)
            .with_context(|| format!("Failed to read file: {}", e.abs_path.display()))?;
        let content = String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string());
        files_for_xml.push((e.rel_path.to_string_lossy().to_string(), content));
    }

    let xml = build_context_xml(&files_for_xml)?;

    let meta = SliceMeta {
        repo_root: repo_root.to_path_buf(),
        target: target.to_path_buf(),
        budget_tokens,
        total_tokens,
        total_files: picked.len(),
        total_bytes,
    };

    Ok((xml, meta))
}
