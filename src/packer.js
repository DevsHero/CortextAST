import fg from "fast-glob";
import ignore from "ignore";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DEFAULT_IGNORE = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/target/**",
  "**/.context-slicer/**",
  "**/.DS_Store"
];

function loadGitignore(repoRoot) {
  const p = join(repoRoot, ".gitignore");
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function createGitignoreFilter(repoRoot, extraPatterns = []) {
  const ig = ignore();
  const gitignoreText = loadGitignore(repoRoot);
  if (gitignoreText) ig.add(gitignoreText);
  if (extraPatterns.length) ig.add(extraPatterns);

  return (absPath) => {
    const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
    return !ig.ignores(rel);
  };
}

function safeReadText(filePath, maxBytes) {
  const st = statSync(filePath);
  if (!st.isFile()) return null;
  if (st.size > maxBytes) return null;

  // Read as UTF-8; if it contains invalid sequences, Node will replace.
  return readFileSync(filePath, "utf8");
}

function stripEmptyLines(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

function escapeXmlAttr(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function cdata(text) {
  // Avoid closing the CDATA section.
  return "<![CDATA[" + text.replaceAll("]]>", "]]]]><![CDATA[>") + "]]>";
}

export async function listFiles({ repoRoot, include, extraIgnore = [] }) {
  const ignorePatterns = [...DEFAULT_IGNORE, ...extraIgnore];

  const relPaths = await fg(include, {
    cwd: repoRoot,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: ignorePatterns
  });

  const absPaths = relPaths.map((p) => join(repoRoot, p));

  const keep = createGitignoreFilter(repoRoot);
  return absPaths.filter(keep);
}

export function estimateTokensFromBytes(totalBytes, charsPerToken = 4) {
  // Approx: 1 token ~= 4 chars for English-ish code; bytes ~= chars for UTF-8 ASCII.
  return Math.ceil(totalBytes / charsPerToken);
}

export function sumFileSizes(paths) {
  let total = 0;
  for (const p of paths) {
    try {
      const st = statSync(p);
      if (st.isFile()) total += st.size;
    } catch {
      // ignore
    }
  }
  return total;
}

export function buildXml({ repoRoot, filePaths, maxFileBytes, removeEmptyLines }) {
  let totalChars = 0;
  const entries = [];

  for (const absPath of filePaths) {
    const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
    const contentRaw = safeReadText(absPath, maxFileBytes);
    if (contentRaw === null) continue;

    const content = removeEmptyLines ? stripEmptyLines(contentRaw) : contentRaw;
    totalChars += content.length;

    entries.push(`  <file path="${escapeXmlAttr(rel)}">${cdata(content)}</file>`);
  }

  const xml = [
    "<context_slicer>",
    ...entries,
    "</context_slicer>",
    ""
  ].join("\n");

  return { xml, totalChars, totalFiles: entries.length };
}
