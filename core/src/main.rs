use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use context_slicer::config::load_config;
use context_slicer::inspector::analyze_file;
use context_slicer::mapper::{build_module_graph, build_repo_map, build_repo_map_scoped};
use context_slicer::slicer::slice_to_xml;
use serde_json::json;
use std::io::{BufRead, Write};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "context-slicer")]
#[command(version = "0.1.0")]
#[command(about = "High-performance context slicer (Rust)")]
struct Cli {
    /// Output a repo map JSON to stdout (nodes + edges)
    #[arg(long)]
    map: bool,

    /// Output a high-level module dependency graph (nodes=modules, edges=imports). Optional ROOT scopes scanning.
    #[arg(long, value_name = "ROOT", num_args = 0..=1, default_missing_value = ".")]
    graph_modules: Option<PathBuf>,

    /// Optional subdirectory path to scope mapping (only valid with --map)
    #[arg(value_name = "SUBDIR_PATH", requires = "map")]
    map_target: Option<PathBuf>,

    /// Inspect a single file and output extracted symbols as JSON
    #[arg(long, value_name = "FILE_PATH")]
    inspect: Option<PathBuf>,

    /// Target module/directory path (relative to repo root)
    #[arg(long, short = 't')]
    target: Option<PathBuf>,

    /// Output XML to stdout (also writes .context-slicer/active_context.xml)
    #[arg(long)]
    xml: bool,

    /// Token budget override
    #[arg(long, default_value_t = 32_000)]
    budget_tokens: usize,

    #[command(subcommand)]
    cmd: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start MCP stdio server
    Mcp,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    if matches!(cli.cmd, Some(Command::Mcp)) {
        return run_mcp();
    }

    let repo_root = std::env::current_dir().context("Failed to get current dir")?;

    if let Some(root) = cli.graph_modules.as_ref() {
        let graph = build_module_graph(&repo_root, root)?;
        println!("{}", serde_json::to_string(&graph)?);
        return Ok(());
    }

    if let Some(p) = cli.inspect {
        let abs = if p.is_absolute() { p } else { repo_root.join(&p) };
        let mut out = analyze_file(&abs)?;
        // Prefer repo-relative file path in JSON output.
        if let Ok(rel) = abs.strip_prefix(&repo_root) {
            out.file = rel.to_string_lossy().replace('\\', "/");
        } else {
            out.file = abs.to_string_lossy().replace('\\', "/");
        }
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    if cli.map {
        let map = if let Some(scope) = cli.map_target.as_ref() {
            build_repo_map_scoped(&repo_root, scope)?
        } else {
            build_repo_map(&repo_root)?
        };
        println!("{}", serde_json::to_string(&map)?);
        return Ok(());
    }

    let target = cli.target.context("Missing --target")?;
    let cfg = load_config(&repo_root);

    let (xml, _meta) = slice_to_xml(&repo_root, &target, cli.budget_tokens, &cfg)?;

    // Ensure output dir exists and write file.
    let out_dir = repo_root.join(&cfg.output_dir);
    std::fs::create_dir_all(&out_dir)?;
    std::fs::write(out_dir.join("active_context.xml"), &xml)?;

    // Write a small meta file for UIs.
    // (Keeps format similar to legacy implementations.)
    let meta_json = json!({
        "repoRoot": repo_root.to_string_lossy(),
        "target": target.to_string_lossy(),
        "budgetTokens": cli.budget_tokens,
        "totalTokens": (xml.len() as f64 / 4.0).ceil() as u64,
        "totalChars": xml.len()
    });
    let _ = std::fs::write(
        out_dir.join("active_context.meta.json"),
        serde_json::to_vec_pretty(&meta_json)?,
    );

    if cli.xml {
        print!("{}", xml);
    } else {
        // Default to printing JSON meta later; for now just confirm success.
        eprintln!("Wrote {} bytes to {}", xml.len(), out_dir.join("active_context.xml").display());
    }

    Ok(())
}

fn run_mcp() -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }

        let msg: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");

        let reply = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": msg.get("params").and_then(|p| p.get("protocolVersion")).cloned().unwrap_or(json!("2024-11-05")),
                    "capabilities": { "tools": { "listChanged": true } },
                    "serverInfo": { "name": "context-slicer-rs", "version": "0.1.0" }
                }
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {
                            "name": "get_context_slice",
                            "description": "Return the generated context slice as XML",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "repoPath": { "type": "string" },
                                    "target": { "type": "string" },
                                    "budget_tokens": { "type": "integer", "exclusiveMinimum": 0 }
                                },
                                "required": ["target"]
                            },
                            "execution": { "taskSupport": "forbidden" }
                        }
                    ]
                }
            }),
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or(json!({}));
                let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name != "get_context_slice" {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "content": [{"type":"text","text":"Tool not found"}], "isError": true }
                    })
                } else {
                    let args = params.get("arguments").cloned().unwrap_or(json!({}));
                    let repo_root = args
                        .get("repoPath")
                        .and_then(|v| v.as_str())
                        .map(PathBuf::from)
                        .unwrap_or_else(|| std::env::current_dir().unwrap());

                    let target_str = args.get("target").and_then(|v| v.as_str());
                    if target_str.is_none() {
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "content": [{"type":"text","text":"Missing target"}], "isError": true }
                        })
                    } else {
                        let target = PathBuf::from(target_str.unwrap());

                    let budget_tokens = args
                        .get("budget_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(32_000) as usize;

                        let cfg = load_config(&repo_root);
                        match slice_to_xml(&repo_root, &target, budget_tokens, &cfg) {
                            Ok((xml, _meta)) => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": { "content": [{"type":"text","text": xml}] }
                            }),
                            Err(e) => json!({
                                "jsonrpc": "2.0",
                                "id": id,
                                "result": { "content": [{"type":"text","text": e.to_string()}], "isError": true }
                            }),
                        }
                    }
                }
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{"type":"text","text":"Method not supported"}], "isError": true }
            }),
        };

        writeln!(stdout, "{}", reply.to_string())?;
        stdout.flush()?;
    }

    Ok(())
}
