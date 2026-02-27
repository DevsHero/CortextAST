//! CSV / TSV engine — uses the `csv` crate for parsing.
//!
//! Provides schema inference, row preview, and simple column/row filtering
//! without pulling in a heavy SQL dependency.

use super::FileExplorer;
use anyhow::{Context, Result};
use std::path::Path;

const DEFAULT_MAX_ROWS: usize = 50;

/// Tabular data engine for `.csv` and `.tsv` files.
pub struct CsvEngine;

impl CsvEngine {
    pub fn new() -> Self { Self }

    /// Detect the delimiter from the file extension.
    fn delimiter(path: &Path) -> u8 {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "tsv" => b'\t',
            _     => b',',
        }
    }
}

impl FileExplorer for CsvEngine {
    fn name(&self) -> &'static str { "csv" }

    fn supported_extensions(&self) -> &'static [&'static str] {
        &["csv", "tsv"]
    }

    fn get_overview(&self, path: &Path, max_rows: usize) -> Result<String> {
        let delim = Self::delimiter(path);
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(delim)
            .has_headers(true)
            .flexible(true)
            .from_path(path)
            .with_context(|| format!("opening CSV: {}", path.display()))?;

        let headers: Vec<String> = rdr
            .headers()
            .with_context(|| "reading CSV headers")?
            .iter()
            .map(|h| h.to_string())
            .collect();

        let col_count = headers.len();
        let mut rows: Vec<Vec<String>> = Vec::new();

        for result in rdr.records().take(max_rows.min(DEFAULT_MAX_ROWS)) {
            let record = result.with_context(|| "reading CSV record")?;
            rows.push(record.iter().map(|f| f.to_string()).collect());
        }

        let row_count = rows.len();

        // Compute column widths for pretty-printing.
        let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
        for row in &rows {
            for (i, cell) in row.iter().enumerate() {
                if i < widths.len() {
                    widths[i] = widths[i].max(cell.len().min(40));
                }
            }
        }

        let mut out = String::new();
        out.push_str(&format!(
            "# CSV overview: {} ({} columns, showing up to {} rows)\n\n",
            path.file_name().unwrap_or_default().to_string_lossy(),
            col_count,
            row_count,
        ));

        // Header row.
        let header_line: Vec<String> = headers
            .iter()
            .enumerate()
            .map(|(i, h)| format!("{:width$}", h, width = widths.get(i).copied().unwrap_or(10)))
            .collect();
        out.push_str(&header_line.join(" | "));
        out.push('\n');

        // Separator.
        let sep: Vec<String> = widths.iter().map(|w| "-".repeat(*w)).collect();
        out.push_str(&sep.join("-+-"));
        out.push('\n');

        // Data rows.
        for row in &rows {
            let cells: Vec<String> = (0..col_count)
                .map(|i| {
                    let cell = row.get(i).map(|s| s.as_str()).unwrap_or("");
                    let truncated = if cell.len() > 40 {
                        format!("{}…", &cell[..39])
                    } else {
                        cell.to_string()
                    };
                    format!(
                        "{:width$}",
                        truncated,
                        width = widths.get(i).copied().unwrap_or(10)
                    )
                })
                .collect();
            out.push_str(&cells.join(" | "));
            out.push('\n');
        }

        Ok(out)
    }

    /// Read CSV content, optionally filtering rows that contain `query` as a
    /// substring in any field.  Returns up to `max_chars` of formatted output.
    fn read_target(&self, path: &Path, query: Option<&str>, max_chars: usize) -> Result<String> {
        let delim = Self::delimiter(path);
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(delim)
            .has_headers(true)
            .flexible(true)
            .from_path(path)
            .with_context(|| format!("opening CSV: {}", path.display()))?;

        let headers: Vec<String> = rdr
            .headers()
            .with_context(|| "reading CSV headers")?
            .iter()
            .map(|h| h.to_string())
            .collect();

        let mut out = String::new();
        out.push_str(&headers.join(","));
        out.push('\n');

        let filter = query.unwrap_or("").to_lowercase();

        for result in rdr.records() {
            let record = result.with_context(|| "reading record")?;
            let row_str: Vec<&str> = record.iter().collect();

            // Filter: keep rows where any cell contains the query substring.
            if !filter.is_empty() {
                let matched = row_str.iter().any(|cell| {
                    cell.to_lowercase().contains(&filter)
                });
                if !matched {
                    continue;
                }
            }

            out.push_str(&row_str.join(","));
            out.push('\n');

            if out.len() >= max_chars {
                out.push_str(&format!("\n[output truncated at {} chars]\n", max_chars));
                break;
            }
        }

        Ok(out)
    }
}
