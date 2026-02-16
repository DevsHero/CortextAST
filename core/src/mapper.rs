use anyhow::Result;
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct MapNode {
    pub id: String,
    pub label: String,
    pub path: String,
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

fn read_package_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn deps_from_package_json(v: &serde_json::Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for key in ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
        if let Some(obj) = v.get(key).and_then(|x| x.as_object()) {
            for (name, _) in obj.iter() {
                out.insert(name.to_string());
            }
        }
    }
    out
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

fn path_has_component(path: &Path, name: &str) -> bool {
    for comp in path.components() {
        let std::path::Component::Normal(os) = comp else {
            continue;
        };
        if os == name {
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

fn verbose_walk_enabled() -> bool {
    matches!(
        std::env::var("CONTEXT_SLICER_DEBUG_WALK").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

fn debug_keep_drop(path: &Path, keep: bool, reason: &str) {
    if !verbose_walk_enabled() {
        return;
    }
    if keep {
        eprintln!("KEEP: {:?} ({})", path, reason);
    } else {
        eprintln!("DROP: {:?} ({})", path, reason);
    }
}

pub fn build_repo_map(repo_root: &Path) -> Result<RepoMap> {
    // Heuristic: if monorepo folders exist, scan them; otherwise scan repo root.
    let mut roots: Vec<PathBuf> = Vec::new();
    for name in ["apps", "libs", "modules"] {
        let p = repo_root.join(name);
        if p.is_dir() {
            roots.push(p);
        }
    }
    if roots.is_empty() {
        roots.push(repo_root.to_path_buf());
    }

    // Collect candidate module dirs and accumulate a rough size estimate.
    // For speed: limit depth; rely on ignore crate for .gitignore/.ignore.
    let mut module_dirs: BTreeSet<PathBuf> = BTreeSet::new();
    let mut bytes_by_module_dir: BTreeMap<PathBuf, u64> = BTreeMap::new();
    let mut package_json_files: Vec<PathBuf> = Vec::new();

    for root in &roots {
        let walker = WalkBuilder::new(root)
            .standard_filters(true)
            .hidden(false)
            .max_depth(Some(6))
            .filter_entry(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_str().unwrap_or("");

                // Debug marker: prove traversal is happening.
                if name == "src" || name == "apps" {
                    eprintln!("DEBUG: Found directory {:?}", path);
                }

                // DENY: if the entry name is a forbidden directory, prune immediately.
                if should_skip_dir_name(name) {
                    debug_keep_drop(path, false, "deny:forbidden-dir-name");
                    return false;
                }

                // DENY: if any component in the path is forbidden, prune.
                if path_has_forbidden_component(path) {
                    debug_keep_drop(path, false, "deny:forbidden-path-component");
                    return false;
                }

                // ALLOW: always recurse into directories (unless denied above).
                if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                    debug_keep_drop(path, true, "allow:dir");
                    return true;
                }

                // ALLOW: only keep files with known text/source extensions.
                if is_allowed_ext(path) {
                    debug_keep_drop(path, true, "allow:ext");
                    return true;
                }

                // DEFAULT: drop unknown/binary-ish files.
                debug_keep_drop(path, false, "default:drop");
                false
            })
            .build();

        for entry in walker {
            let dent = match entry {
                Ok(d) => d,
                Err(_) => continue,
            };

            if !dent.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }

            let path = dent.path();

            // Guard rail: if anything under node_modules slips through, emit a debug line and skip.
            // This should NEVER happen with the filter_entry above.
            if path_has_component(path, "node_modules") {
                eprintln!("LEAK: Found garbage {:?}", path);
                continue;
            }

            // Also never process files inside any forbidden folder (defense in depth).
            if path_has_forbidden_component(path) {
                continue;
            }

            // Only process allowed extensions (defense in depth).
            if !is_allowed_ext(path) {
                continue;
            }
            let file_name = match path.file_name().and_then(|s| s.to_str()) {
                Some(s) => s,
                None => continue,
            };

            if file_name == "package.json" {
                if let Some(parent) = path.parent() {
                    module_dirs.insert(parent.to_path_buf());
                    package_json_files.push(path.to_path_buf());
                }
            }

            if matches!(
                file_name,
                "lib.rs" | "mod.rs" | "index.ts" | "index.tsx" | "index.js" | "Cargo.toml"
            ) {
                if let Some(parent) = path.parent() {
                    module_dirs.insert(parent.to_path_buf());
                }
            }

            // Rough size estimation: sum file sizes into the closest module_dir ancestor.
            let size = dent.metadata().map(|m| m.len()).unwrap_or(0);
            if size == 0 {
                continue;
            }

            // Find nearest module dir ancestor (bounded).
            let mut cur = path.parent();
            for _ in 0..6 {
                let Some(dir) = cur else { break };
                if module_dirs.contains(dir) {
                    *bytes_by_module_dir.entry(dir.to_path_buf()).or_insert(0) += size;
                    break;
                }
                cur = dir.parent();
            }
        }
    }

    // Map package name -> module id for internal dependency edges.
    let mut package_name_to_module_id: BTreeMap<String, String> = BTreeMap::new();
    let mut module_id_to_package_json: BTreeMap<String, PathBuf> = BTreeMap::new();

    for pj in &package_json_files {
        let Some(parent) = pj.parent() else { continue };
        let Some(rel) = rel_str(repo_root, parent) else { continue };
        let module_id = normalize_module_id(&rel);

        let Some(v) = read_package_json(pj) else { continue };
        let Some(name) = v.get("name").and_then(|x| x.as_str()) else { continue };

        package_name_to_module_id.insert(name.to_string(), module_id.clone());
        module_id_to_package_json.insert(module_id, pj.to_path_buf());
    }

    // Build nodes.
    let mut nodes: Vec<MapNode> = Vec::new();
    let mut module_id_set: BTreeSet<String> = BTreeSet::new();

    for dir in &module_dirs {
        let Some(rel) = rel_str(repo_root, dir) else { continue };
        let id = normalize_module_id(&rel);

        let label = if rel.is_empty() {
            repo_root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("root")
                .to_string()
        } else {
            dir.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&id)
                .to_string()
        };

        let bytes = *bytes_by_module_dir.get(dir).unwrap_or(&0);
        let size_class = size_class_from_bytes(bytes);
        let est_tokens = est_tokens_from_bytes(bytes);

        nodes.push(MapNode {
            id: id.clone(),
            label,
            path: id.clone(),
            size_class,
            bytes,
            est_tokens,
        });
        module_id_set.insert(id);
    }

    nodes.sort_by(|a, b| a.id.cmp(&b.id));

    // Build edges by reading package.json deps.
    let mut edges: Vec<MapEdge> = Vec::new();

    for (module_id, pj) in &module_id_to_package_json {
        let Some(v) = read_package_json(pj) else { continue };
        let deps = deps_from_package_json(&v);

        for dep in deps {
            if let Some(target_module_id) = package_name_to_module_id.get(&dep) {
                if target_module_id == module_id {
                    continue;
                }
                if !module_id_set.contains(target_module_id) {
                    continue;
                }
                let id = format!("{}->{}", module_id, target_module_id);
                edges.push(MapEdge {
                    id,
                    source: module_id.clone(),
                    target: target_module_id.clone(),
                });
            }
        }
    }

    edges.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(RepoMap { nodes, edges })
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

    let mut nodes: Vec<MapNode> = Vec::new();
    let mut edges: Vec<MapEdge> = Vec::new();

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

    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(RepoMap { nodes, edges })
}
