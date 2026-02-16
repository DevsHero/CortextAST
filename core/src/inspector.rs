use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser, Query, QueryCursor};

#[derive(Debug, Clone, Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: String,

    /// 0-indexed start line
    pub line: u32,

    /// 0-indexed end line (inclusive-ish; derived from tree-sitter end position)
    pub line_end: u32,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileSymbols {
    pub file: String,
    pub symbols: Vec<Symbol>,
}

fn normalize_path_for_output(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn pick_language(path: &Path) -> Option<(Language, &'static str)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "rs" => Some((tree_sitter_rust::language(), "rust")),
        "ts" | "mts" | "cts" => Some((tree_sitter_typescript::language_typescript(), "typescript")),
        "tsx" => Some((tree_sitter_typescript::language_tsx(), "tsx")),
        "js" | "jsx" | "mjs" | "cjs" => Some((tree_sitter_typescript::language_typescript(), "javascript")),
        "py" => Some((tree_sitter_python::language(), "python")),
        _ => {
            if file_name.ends_with(".d.ts") {
                return Some((tree_sitter_typescript::language_typescript(), "typescript"));
            }
            None
        }
    }
}

fn first_line_signature(def_text: &str) -> String {
    let mut s = def_text;
    if let Some(i) = s.find('{') {
        s = &s[..i];
    }
    if let Some(i) = s.find("\n") {
        s = &s[..i];
    }

    // Collapse whitespace for readability.
    let mut out = String::with_capacity(s.len().min(200));
    let mut prev_ws = false;
    for ch in s.chars() {
        let is_ws = ch.is_whitespace();
        if is_ws {
            if !prev_ws {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
        prev_ws = is_ws;
        if out.len() >= 240 {
            break;
        }
    }

    out.trim().trim_end_matches('{').trim().to_string()
}

fn node_text<'a>(source: &'a [u8], node: Node) -> &'a str {
    let start = node.start_byte();
    let end = node.end_byte();
    std::str::from_utf8(&source[start..end]).unwrap_or("")
}

fn run_query(
    source: &[u8],
    root: Node,
    language: Language,
    query_src: &str,
    kind: &str,
    include_signature: bool,
) -> Result<Vec<Symbol>> {
    let query = Query::new(language, query_src).context("Failed to compile tree-sitter query")?;
    let mut cursor = QueryCursor::new();

    let mut out: Vec<Symbol> = Vec::new();

    for m in cursor.matches(&query, root, source) {
        let mut name_node: Option<Node> = None;
        let mut def_node: Option<Node> = None;

        for cap in m.captures {
            let cap_name = query.capture_names()[cap.index as usize].as_str();
            match cap_name {
                "name" => name_node = Some(cap.node),
                "def" => def_node = Some(cap.node),
                _ => {}
            }
        }

        let Some(name_node) = name_node else { continue };
        let def_node = def_node.unwrap_or(name_node);

        let name = node_text(source, name_node).trim().to_string();
        if name.is_empty() {
            continue;
        }

        let start = def_node.start_position();
        let end = def_node.end_position();

        let signature = if include_signature {
            let def_text = node_text(source, def_node);
            Some(first_line_signature(def_text))
        } else {
            None
        };

        out.push(Symbol {
            name,
            kind: kind.to_string(),
            line: start.row as u32,
            line_end: end.row as u32,
            signature,
        });
    }

    Ok(out)
}

/// Parse a single file and extract symbols (functions/structs/classes) using tree-sitter.
///
/// - Lines are 0-indexed.
/// - `file` is emitted as the provided path string (normalized to '/').
pub fn analyze_file(path: &Path) -> Result<FileSymbols> {
    let abs: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().context("Failed to get current dir")?.join(path)
    };

    let (language, _lang_name) =
        pick_language(&abs).ok_or_else(|| anyhow!("Unsupported file extension: {}", abs.display()))?;

    let source_text = std::fs::read_to_string(&abs)
        .with_context(|| format!("Failed to read {}", abs.display()))?;
    let source = source_text.as_bytes();

    let mut parser = Parser::new();
    parser
        .set_language(language)
        .context("Failed to set tree-sitter language")?;

    let tree = parser
        .parse(source_text.as_str(), None)
        .ok_or_else(|| anyhow!("Failed to parse file"))?;

    let root = tree.root_node();

    let mut symbols: Vec<Symbol> = Vec::new();

    // Rust
    if abs.extension().and_then(|e| e.to_str()).unwrap_or("") == "rs" {
        symbols.extend(run_query(
            source,
            root,
            language,
            r#"(function_item name: (identifier) @name) @def"#,
            "function",
            true,
        )?);
        symbols.extend(run_query(
            source,
            root,
            language,
            r#"(struct_item name: (type_identifier) @name) @def"#,
            "struct",
            false,
        )?);
        symbols.extend(run_query(
            source,
            root,
            language,
            r#"(enum_item name: (type_identifier) @name) @def"#,
            "enum",
            false,
        )?);
        symbols.extend(run_query(
            source,
            root,
            language,
            r#"(trait_item name: (type_identifier) @name) @def"#,
            "trait",
            false,
        )?);
    } else {
        // TypeScript / TSX / JS
        let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext == "ts" || ext == "tsx" || ext == "js" || ext == "jsx" || ext == "mjs" || ext == "cjs" {
            symbols.extend(run_query(
                source,
                root,
                language,
                r#"(function_declaration name: (identifier) @name) @def"#,
                "function",
                true,
            )?);

            // const foo = () => {}
            // (Note: we treat these as functions; signature extraction will take first line.)
            symbols.extend(run_query(
                source,
                root,
                language,
                r#"(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @def"#,
                "function",
                true,
            )?);
            symbols.extend(run_query(
                source,
                root,
                language,
                r#"(class_declaration name: (type_identifier) @name) @def"#,
                "class",
                false,
            )?);

            // Methods inside classes
            symbols.extend(run_query(
                source,
                root,
                language,
                r#"(method_definition name: (property_identifier) @name) @def"#,
                "method",
                true,
            )?);
        } else if ext == "py" {
            symbols.extend(run_query(
                source,
                root,
                language,
                r#"(function_definition name: (identifier) @name) @def"#,
                "function",
                true,
            )?);
            symbols.extend(run_query(
                source,
                root,
                language,
                r#"(class_definition name: (identifier) @name) @def"#,
                "class",
                false,
            )?);
        }
    }

    // Stable ordering: by line then name.
    symbols.sort_by(|a, b| a.line.cmp(&b.line).then_with(|| a.name.cmp(&b.name)));

    Ok(FileSymbols {
        file: normalize_path_for_output(path),
        symbols,
    })
}
