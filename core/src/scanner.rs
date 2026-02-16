use anyhow::{Context, Result};
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub abs_path: PathBuf,
    pub rel_path: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub repo_root: PathBuf,
    pub target: PathBuf,
    pub max_file_bytes: u64,
    pub exclude_dir_names: Vec<String>,
}

impl ScanOptions {
    pub fn target_root(&self) -> PathBuf {
        if self.target.is_absolute() {
            self.target.clone()
        } else {
            self.repo_root.join(&self.target)
        }
    }
}

pub fn scan_workspace(opts: &ScanOptions) -> Result<Vec<FileEntry>> {
    let target_root = opts.target_root();

    let meta = std::fs::metadata(&target_root)
        .with_context(|| format!("Target does not exist: {}", target_root.display()))?;

    if meta.is_file() {
        return scan_single_file(&opts.repo_root, &target_root, opts.max_file_bytes)
            .map(|v| v.into_iter().collect());
    }

    let mut entries = Vec::new();
    let walker = WalkBuilder::new(&target_root)
        .standard_filters(true) // .gitignore, .ignore, hidden, etc.
        .build();

    for item in walker {
        let dent = match item {
            Ok(d) => d,
            Err(_) => continue,
        };

        if !dent.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }

        let abs_path = dent.into_path();
        if should_exclude_path(&abs_path, &opts.exclude_dir_names) {
            continue;
        }

        let bytes = match std::fs::metadata(&abs_path).and_then(|m| Ok(m.len())) {
            Ok(b) => b,
            Err(_) => continue,
        };

        if bytes == 0 || bytes > opts.max_file_bytes {
            continue;
        }

        let rel_path = path_relative_to(&abs_path, &opts.repo_root)
            .with_context(|| format!("Failed to relativize path: {}", abs_path.display()))?;

        entries.push(FileEntry {
            abs_path,
            rel_path,
            bytes,
        });
    }

    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(entries)
}

fn scan_single_file(repo_root: &Path, abs_path: &Path, max_file_bytes: u64) -> Result<Vec<FileEntry>> {
    let bytes = std::fs::metadata(abs_path)?.len();
    if bytes == 0 || bytes > max_file_bytes {
        return Ok(vec![]);
    }

    let rel_path = path_relative_to(abs_path, repo_root)?;
    Ok(vec![FileEntry {
        abs_path: abs_path.to_path_buf(),
        rel_path,
        bytes,
    }])
}

fn should_exclude_path(abs_path: &Path, exclude_dir_names: &[String]) -> bool {
    // Fast path: no exclusions.
    if exclude_dir_names.is_empty() {
        return false;
    }

    abs_path
        .components()
        .any(|c| exclude_dir_names.iter().any(|x| c.as_os_str() == x.as_str()))
}

fn path_relative_to(path: &Path, base: &Path) -> Result<PathBuf> {
    let rel = path
        .strip_prefix(base)
        .with_context(|| format!("{} is not under {}", path.display(), base.display()))?;
    Ok(rel.to_path_buf())
}
