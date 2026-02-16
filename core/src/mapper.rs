use anyhow::Result;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::inspector::analyze_file;

#[derive(Debug, Clone, Serialize)]
pub struct MapNode {
    pub id: String,
    pub label: String,
    pub path: String,
    pub kind: String,
    pub size_class: String,
    pub bytes: u64,
    pub est_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapEdge {
    pub id: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoMap {
    pub nodes: Vec<MapNode>,
    pub edges: Vec<MapEdge>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModuleNode {
    pub id: String,
    pub label: String,
    pub path: String,
    pub file_count: u64,
    pub bytes: u64,
    pub est_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModuleEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub weight: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModuleGraph {
    pub nodes: Vec<ModuleNode>,
    pub edges: Vec<ModuleEdge>,
}

fn size_class_from_bytes(bytes: u64) -> String {
    if bytes < 200_000 {
        "small".to_string()
    } else if bytes < 1_500_000 {
        "medium".to_string()
    } else {
        "large".to_string()
    }
}

fn est_tokens_from_bytes(bytes: u64) -> u64 {
    // Match the simple heuristic used elsewhere: ~4 chars per token.
    ((bytes as f64) / 4.0).ceil() as u64
}

fn is_module_marker_file(name: &str) -> bool {
    matches!(
        name,
        "package.json"
            | "index.ts"
            | "index.tsx"
            | "index.js"
            | "index.jsx"
            | "mod.rs"
    )
        // Practical Rust crate roots (often no mod.rs at root)
        || matches!(name, "lib.rs" | "main.rs")
}

fn module_label(repo_root: &Path, module_abs: &Path) -> String {
    if module_abs == repo_root {
        return repo_root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("root")
            .to_string();
    }
    module_abs
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("module")
        .to_string()
}

fn resolve_ts_import(repo_root: &Path, from_file_abs: &Path, imp: &str) -> Option<PathBuf> {
    let imp = imp.trim();
    if !imp.starts_with('.') {
        return None;
    }

    let base_dir = from_file_abs.parent()?;

    let exts = ["ts", "tsx", "js", "jsx", "json", "md", "toml", "css", "html"];
    let mut candidates: Vec<PathBuf> = Vec::new();

    candidates.push(base_dir.join(imp));
    for e in exts {
        candidates.push(base_dir.join(format!("{}.{}", imp, e)));
    }
    for e in ["ts", "tsx", "js", "jsx"] {
        candidates.push(base_dir.join(imp).join(format!("index.{}", e)));
    }

    for cand in candidates {
        if !cand.exists() {
            continue;
        }
        let cand_abs = cand.canonicalize().unwrap_or(cand);
        if cand_abs.strip_prefix(repo_root).is_ok() {
            return Some(cand_abs);
        }
    }

    None
}

fn find_owner_module<'a>(mut dir: &'a Path, stop_at: &Path, module_roots: &BTreeSet<PathBuf>) -> Option<PathBuf> {
    loop {
        if module_roots.contains(dir) {
            return Some(dir.to_path_buf());
        }
        if dir == stop_at {
            return None;
        }
        dir = dir.parent()?;
    }
}

/// High-level architecture graph: nodes are module roots; edges are weighted imports between modules.
pub fn build_module_graph(repo_root: &Path, root: &Path) -> Result<ModuleGraph> {
    let root_abs = if root.is_absolute() {
        root.to_path_buf()
    } else {
        repo_root.join(root)
    }
    .canonicalize()
    .unwrap_or_else(|_| repo_root.join(root));

    if !root_abs.exists() {
        anyhow::bail!("Graph root not found: {}", root_abs.display());
    }
    if !root_abs.is_dir() {
        anyhow::bail!("Graph root is not a directory: {}", root_abs.display());
    }

    // 1) Discover module roots (directories containing marker files).
    let mut module_roots: BTreeSet<PathBuf> = BTreeSet::new();
    module_roots.insert(root_abs.clone());

    let walker = WalkBuilder::new(&root_abs)
        .standard_filters(true)
        .hidden(false)
        .max_depth(Some(25))
        .filter_entry(|entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            if should_skip_dir_name(name) {
                return false;
            }
            if path_has_forbidden_component(entry.path()) {
                return false;
            }
            true
        })
        .build();

    for ent in walker {
        let Ok(ent) = ent else { continue };
        if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = ent.path();
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else { continue };
        if !is_module_marker_file(name) {
            continue;
        }
        let Some(parent) = p.parent() else { continue };
        module_roots.insert(parent.to_path_buf());
    }

    // 2) Assign files to their owning module (nearest ancestor module root).
    #[derive(Default)]
    struct ModuleAcc {
        bytes: u64,
        file_count: u64,
        files: Vec<PathBuf>,
    }

    let mut modules: BTreeMap<PathBuf, ModuleAcc> = BTreeMap::new();
    for r in &module_roots {
        modules.entry(r.clone()).or_default();
    }

    let walker2 = WalkBuilder::new(&root_abs)
        .standard_filters(true)
        .hidden(false)
        .max_depth(Some(25))
        .filter_entry(|entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            if should_skip_dir_name(name) {
                return false;
            }
            if path_has_forbidden_component(entry.path()) {
                return false;
            }
            true
        })
        .build();

    for ent in walker2 {
        let Ok(ent) = ent else { continue };
        if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = ent.path();
        if path_has_forbidden_component(p) {
            continue;
        }
        if !is_allowed_ext(p) {
            continue;
        }
        let Some(parent) = p.parent() else { continue };
        let owner = find_owner_module(parent, &root_abs, &module_roots).unwrap_or_else(|| root_abs.clone());
        let acc = modules.entry(owner).or_default();
        let sz = ent.metadata().map(|m| m.len()).unwrap_or(0);
        acc.bytes += sz;
        acc.file_count += 1;
        acc.files.push(p.to_path_buf());
    }

    // 3) Build nodes.
    let mut nodes: Vec<ModuleNode> = Vec::new();
    let mut module_id_by_abs: BTreeMap<PathBuf, String> = BTreeMap::new();

    for (abs, acc) in &modules {
        let rel = abs.strip_prefix(repo_root).ok().map(|r| r.to_string_lossy().replace('\\', "/"));
        let id = normalize_module_id(rel.as_deref().unwrap_or("."));
        module_id_by_abs.insert(abs.clone(), id.clone());
        nodes.push(ModuleNode {
            id: id.clone(),
            label: module_label(repo_root, abs),
            path: id,
            file_count: acc.file_count,
            bytes: acc.bytes,
            est_tokens: est_tokens_from_bytes(acc.bytes),
        });
    }

    nodes.sort_by(|a, b| a.id.cmp(&b.id));

    // 4) Edges: file imports -> module imports, weighted.
    let mut weights: BTreeMap<(String, String), u64> = BTreeMap::new();

    for (module_abs, acc) in &modules {
        let Some(src_mod_id) = module_id_by_abs.get(module_abs).cloned() else { continue };
        for file_abs in &acc.files {
            let analyzed = match analyze_file(file_abs) {
                Ok(v) => v,
                Err(_) => continue,
            };

            for imp in analyzed.imports {
                let Some(dst_file_abs) = resolve_ts_import(repo_root, file_abs, &imp) else { continue };
                let Some(dst_parent) = dst_file_abs.parent() else { continue };
                let dst_owner = find_owner_module(dst_parent, &root_abs, &module_roots).unwrap_or_else(|| root_abs.clone());
                let Some(dst_mod_id) = module_id_by_abs.get(&dst_owner).cloned() else { continue };
                if dst_mod_id == src_mod_id {
                    continue;
                }
                *weights.entry((src_mod_id.clone(), dst_mod_id)).or_insert(0) += 1;
            }
        }
    }

    let mut edges: Vec<ModuleEdge> = Vec::new();
    for ((s, t), w) in weights {
        edges.push(ModuleEdge {
            id: format!("{}->{}", s, t),
            source: s,
            target: t,
            weight: w,
        });
    }
    edges.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(ModuleGraph { nodes, edges })
}

fn rel_str(repo_root: &Path, p: &Path) -> Option<String> {
    p.strip_prefix(repo_root)
        .ok()
        .map(|x| x.to_string_lossy().replace('\\', "/"))
}

fn normalize_module_id(rel: &str) -> String {
    // In single-package repos, the module can be the repository root.
    // rel_str(repo_root, repo_root) yields ""; normalize that to "." so the frontend can handle it.
    if rel.is_empty() {
        ".".to_string()
    } else {
        rel.to_string()
    }
}

fn clamp_label(name: &str) -> String {
    if name.is_empty() {
        return "(unnamed)".to_string();
    }
    name.to_string()
}

fn should_skip_dir_name(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".vscode"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | ".next"
            | ".turbo"
            | ".context-slicer"
            | ".cargo"
    )
}

fn path_has_forbidden_component(path: &Path) -> bool {
    for comp in path.components() {
        let std::path::Component::Normal(os) = comp else {
            continue;
        };
        let Some(s) = os.to_str() else {
            continue;
        };
        if should_skip_dir_name(s) {
            return true;
        }
    }
    false
}

fn is_allowed_ext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext,
        // Rust / JS / TS source
        "rs" | "ts" | "tsx" | "js" | "jsx" |
        // Config / docs
        "json" | "md" | "toml" |
        // Web / styles (small allowlist, safe to count)
        "css" | "scss" | "sass" | "html"
    )
}

pub fn build_repo_map(repo_root: &Path) -> Result<RepoMap> {
    build_repo_map_scoped(repo_root, repo_root)
}

/// Build a scoped repo map for a specific subdirectory.
///
/// Contract for folder expansion UIs:
/// - Only returns the *immediate children* (files + folders) of the scoped directory.
/// - Hard-excludes forbidden folders (node_modules, .git, target, dist, build, etc).
/// - File nodes are only included for allowlisted text/source extensions.
/// - Edges connect `parent_id -> child_id`.
pub fn build_repo_map_scoped(repo_root: &Path, scope: &Path) -> Result<RepoMap> {
    let scope_abs = if scope.is_absolute() {
        scope.to_path_buf()
    } else {
        repo_root.join(scope)
    };

    let scope_abs = scope_abs
        .canonicalize()
        .unwrap_or(scope_abs);

    if !scope_abs.exists() {
        anyhow::bail!("Scope path not found: {}", scope_abs.display());
    }
    if !scope_abs.is_dir() {
        anyhow::bail!("Scope path is not a directory: {}", scope_abs.display());
    }

    // Parent id is the repo-relative directory path.
    let parent_rel = rel_str(repo_root, &scope_abs).unwrap_or_else(|| scope.to_string_lossy().to_string());
    let parent_id = normalize_module_id(&parent_rel);

    // Include the container node itself so the frontend can treat it as a stable "card".
    let parent_label = if parent_id == "." {
        repo_root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("root")
            .to_string()
    } else {
        scope_abs
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&parent_id)
            .to_string()
    };

    let mut nodes: Vec<MapNode> = Vec::new();
    let mut edges: Vec<MapEdge> = Vec::new();

    nodes.push(MapNode {
        id: parent_id.clone(),
        label: parent_label,
        path: parent_id.clone(),
        kind: "directory".to_string(),
        size_class: "small".to_string(),
        bytes: 0,
        est_tokens: 0,
    });

    let rd = std::fs::read_dir(&scope_abs)?;
    for entry in rd {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // HARD DENY by immediate name.
        if should_skip_dir_name(&name) {
            continue;
        }

        // HARD DENY by path component.
        if path_has_forbidden_component(&path) {
            continue;
        }

        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        if ft.is_dir() {
            // Include folder nodes.
            let rel = rel_str(repo_root, &path).unwrap_or_else(|| name.clone());
            let id = normalize_module_id(&rel);
            let label = clamp_label(&name);

            nodes.push(MapNode {
                id: id.clone(),
                label,
                path: id.clone(),
                kind: "directory".to_string(),
                size_class: "small".to_string(),
                bytes: 0,
                est_tokens: 0,
            });

            edges.push(MapEdge {
                id: format!("{}->{}", parent_id, id),
                source: parent_id.clone(),
                target: id,
            });

            continue;
        }

        if ft.is_file() {
            // Only keep allowlisted file types.
            if !is_allowed_ext(&path) {
                continue;
            }

            let rel = rel_str(repo_root, &path).unwrap_or_else(|| name.clone());
            let id = normalize_module_id(&rel);
            let label = clamp_label(&name);
            let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let size_class = size_class_from_bytes(bytes);
            let est_tokens = est_tokens_from_bytes(bytes);

            nodes.push(MapNode {
                id: id.clone(),
                label,
                path: id.clone(),
                kind: "file".to_string(),
                size_class,
                bytes,
                est_tokens,
            });

            edges.push(MapEdge {
                id: format!("{}->{}", parent_id, id),
                source: parent_id.clone(),
                target: id,
            });
        }
    }

    // Smart edges: resolve file-to-file imports (relative imports for TS/JS).
    let mut id_set: BTreeSet<String> = BTreeSet::new();
    for n in &nodes {
        id_set.insert(n.id.clone());
    }

    // Build a quick lookup of existing file ids.
    let mut file_ids: Vec<String> = Vec::new();
    for n in &nodes {
        if n.kind == "file" {
            file_ids.push(n.id.clone());
        }
    }

    // Attempt to resolve relative imports within the repo.
    let exts = ["ts", "tsx", "js", "jsx", "json", "md"];
    for src_id in &file_ids {
        let src_abs = repo_root.join(src_id);
        let analyzed = match analyze_file(&src_abs) {
            Ok(v) => v,
            Err(_) => continue,
        };

        for imp in analyzed.imports {
            let imp = imp.trim();
            if !imp.starts_with('.') {
                continue;
            }

            let base_dir = src_abs.parent().unwrap_or(repo_root);
            let mut candidates: Vec<PathBuf> = Vec::new();

            let raw = base_dir.join(imp);
            candidates.push(raw.clone());
            for e in exts {
                candidates.push(base_dir.join(format!("{}.{}", imp, e)));
            }
            // Directory-style imports: ./foo -> ./foo/index.ts
            for e in ["ts", "tsx", "js", "jsx"] {
                candidates.push(base_dir.join(imp).join(format!("index.{}", e)));
            }

            let mut resolved: Option<String> = None;
            for cand in candidates {
                if !cand.exists() {
                    continue;
                }
                let cand_abs = cand.canonicalize().unwrap_or(cand);
                if let Ok(rel) = cand_abs.strip_prefix(repo_root) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    let id = normalize_module_id(&rel_str);
                    if id_set.contains(&id) {
                        resolved = Some(id);
                        break;
                    }
                }
            }

            let Some(dst_id) = resolved else { continue };
            if dst_id == *src_id {
                continue;
            }

            edges.push(MapEdge {
                id: format!("import:{}->{}", src_id, dst_id),
                source: src_id.clone(),
                target: dst_id,
            });
        }
    }

    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(RepoMap { nodes, edges })
}
