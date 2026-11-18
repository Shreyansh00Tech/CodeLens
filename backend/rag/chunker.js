/**
 * Semantic code chunker.
 *
 * Splits every source file into overlapping, symbol-aware windows so each
 * chunk can be cited back to an exact file + line range.
 */
import fs from "fs";
import path from "path";

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".cache",
  "vendor", "__pycache__", ".venv", "venv", "out", "target",
]);

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|rb|rs|php|cs|kt|swift|vue|svelte)$/i;
const DOC_EXT = /\.(md|mdx|txt|ya?ml|json|toml)$/i;

const MAX_FILE_BYTES = 400 * 1024; // skip giant generated files
const TARGET_LINES = 48;
const MIN_LINES = 12;
const OVERLAP = 6;

// Lines that usually start a new top-level unit of code.
const BOUNDARY = new RegExp(
  [
    String.raw`^\s*export\s+(default\s+)?(async\s+)?(function|class|const|let|interface|type|enum)\b`,
    String.raw`^\s*(async\s+)?function\s+\w+`,
    String.raw`^\s*class\s+\w+`,
    String.raw`^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>`,
    String.raw`^\s*(def|async def)\s+\w+`,
    String.raw`^\s*@(app|router)\.`,
    String.raw`^\s*(app|router)\.(get|post|put|patch|delete|use|route)\s*\(`,
    String.raw`^#{1,3}\s`,
  ].join("|")
);

const SYMBOL_PATTERNS = [
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
];

const RESERVED = new Set(["with", "if", "for", "while", "switch", "catch", "function", "return", "new", "typeof", "in", "of", "do", "else"]);

export function extractSymbols(text) {
  const out = new Set();
  for (const re of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) if (!RESERVED.has(m[1])) out.add(m[1]);
  }
  return [...out].slice(0, 12);
}

/** Walk a repository and return relative file paths worth indexing. */
export function listIndexableFiles(rootDir) {
  const files = [];
  (function walk(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (IGNORE.has(item.name) || item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && (CODE_EXT.test(item.name) || DOC_EXT.test(item.name))) {
        if (/package-lock\.json$|yarn\.lock$|pnpm-lock/.test(item.name)) continue;
        files.push(path.relative(rootDir, full).replace(/\\/g, "/"));
      }
    }
  })(rootDir);
  return files;
}

/** Split one file's text into chunks. Pure function, easy to test. */
export function chunkText(file, text) {
  const lines = text.split("\n");
  const chunks = [];
  if (lines.length === 0) return chunks;

  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + TARGET_LINES);

    // Prefer to cut right before a boundary line, but never make a tiny chunk.
    if (end < lines.length) {
      for (let i = end; i > start + MIN_LINES; i--) {
        if (BOUNDARY.test(lines[i])) {
          end = i;
          break;
        }
      }
    }

    const body = lines.slice(start, end).join("\n");
    if (body.trim().length > 0) {
      chunks.push({
        id: `${file}#L${start + 1}-L${end}`,
        file,
        startLine: start + 1,
        endLine: end,
        text: body,
        symbols: CODE_EXT.test(file) ? extractSymbols(body) : [],
      });
    }

    if (end >= lines.length) break;
    start = Math.max(end - OVERLAP, start + 1);
  }
  return chunks;
}

const MAX_CHUNKS = Number(process.env.CODELENS_MAX_CHUNKS) || 40000;

export function chunkRepository(rootDir) {
  const chunks = [];
  for (const rel of listIndexableFiles(rootDir)) {
    if (chunks.length >= MAX_CHUNKS) break;
    const full = path.join(rootDir, rel);
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("\u0000")) continue; // binary
      chunks.push(...chunkText(rel, text));
    } catch {
      // unreadable file, skip
    }
  }
  return chunks;
}
