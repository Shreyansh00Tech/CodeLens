import "./env.js";
import express from "express";
import simpleGit from "simple-git";
import path from "path";
import fs from "fs-extra";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { analyzeGraphDiagnostics } from "./graphDiagnostics.js";
import { discoverEndpoints, traceFlow } from "./endpoints.js";
import { RagIndex, answerQuestion, describeError, MODEL } from "./rag/ragAgent.js";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const TEMP_DIR = process.env.CODELENS_TMP_DIR || path.join(process.cwd(), "tmp");

// -------------------------
// IGNORE HEAVY FOLDERS
// -------------------------
const IGNORE = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  ".next",
  ".cache",
]);

// -------------------------
// RATE LIMITER ON ANALYZE
// -------------------------
const analyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ANALYZE_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Rate limit exceeded. Try again later.",
  },
});

const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many questions. Slow down a little." },
});

// -------------------------
// CLONE
// -------------------------
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/;

export function normalizeRepoUrl(input) {
  const url = String(input || "").trim().replace(/\/+$/, "");
  if (!GITHUB_URL.test(url)) return null;
  return url.replace(/\.git$/, "");
}

async function cloneRepo(repoUrl) {
  await fs.remove(TEMP_DIR);
  await fs.mkdir(TEMP_DIR);

  await simpleGit().clone(repoUrl, TEMP_DIR, ["--depth", "1"]);
}

// -------------------------
// FAST INDEXER 
// -------------------------
export function buildIndex(dir) {
  const index = {};

  function walk(folder) {
    const items = fs.readdirSync(folder, { withFileTypes: true });

    for (const item of items) {
      if (IGNORE.has(item.name)) continue;

      const fullPath = path.join(folder, item.name);

      if (item.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!item.name.match(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/)) continue;

      try {
        const content = fs.readFileSync(fullPath, "utf8");

        const imports = [
          ...content.matchAll(/from\s+['"](.*?)['"]/g),
          ...content.matchAll(/require\(['"](.*?)['"]\)/g),
          ...content.matchAll(/import\(\s*['"](.*?)['"]\s*\)/g),
          ...content.matchAll(/^\s*import\s+['"](.*?)['"]/gm),
        ].map(m => m[1]);

        const rel = path.relative(dir, fullPath).replace(/\\/g, "/");

        // Line count calculate kar rahe hain (Health Score aur Dead Code Metrics ke liye)
        const lines = content.split('\n').length;

        index[rel] = {
          imports: [...new Set(imports)].slice(0, 60),
          lines: lines
        };

        if (rel.endsWith(".py")) {
          // The JS-style regexes above don't understand Python syntax.
          index[rel].imports = [];
          index[rel].pyImports = extractPyImports(content);
        }

      } catch (e) {
        // Skip unreadable files
      }
    }
  }

  walk(dir);
  return index;
}

export function resolveImport(file, imp, allFiles) {
  if (!imp.startsWith(".")) return null;

  const base = path.posix.dirname(file);
  const joined = path.posix.normalize(path.posix.join(base, imp));
  const stripped = joined.replace(/\.(js|jsx|mjs|cjs|ts|tsx)$/, "");
  const exts = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

  const possiblePaths = [
    joined,
    ...exts.map((e) => stripped + e),
    ...exts.map((e) => path.posix.join(joined, "index" + e)),
  ];

  for (const p of possiblePaths) {
    if (allFiles.has(p)) return p;
  }
  return null;
}

// -------------------------
// PYTHON IMPORTS
// -------------------------
// Returns [{ level, module, names }] where level is the number of leading dots
// (0 = absolute import).
export function extractPyImports(content) {
  const out = [];
  const src = content.replace(/#.*$/gm, "");

  for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const names = m[3]
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
      .filter((n) => /^\w+$/.test(n));
    out.push({ level: m[1].length, module: m[2], names });
  }

  for (const m of src.matchAll(/^[ \t]*import[ \t]+([\w., \t]+)/gm)) {
    for (const part of m[1].split(",")) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(mod)) out.push({ level: 0, module: mod, names: [] });
    }
  }
  return out;
}

function commonPrefixLen(a, b) {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

// Resolve a dotted/relative module path ("pkg/sub/mod") to a repo file.
function findPyModule(candidate, fromFile, fileSet, exact) {
  if (!candidate) return null;
  const direct = [candidate + ".py", candidate + "/__init__.py"];
  for (const d of direct) if (fileSet.has(d)) return d;
  if (exact) return null;

  // Absolute imports: the package root may be a subfolder (src/, lib/, ...).
  let best = null;
  for (const f of fileSet) {
    if (!f.endsWith(".py")) continue;
    if (f.endsWith("/" + candidate + ".py") || f.endsWith("/" + candidate + "/__init__.py")) {
      const score = commonPrefixLen(f, fromFile) * 1000 - f.length;
      if (!best || score > best.score) best = { f, score };
    }
  }
  return best ? best.f : null;
}

export function resolvePyImport(file, imp, fileSet) {
  const results = new Set();
  const modPath = imp.module.replace(/\./g, "/");
  let base = "";

  if (imp.level > 0) {
    let dir = path.posix.dirname(file);
    for (let i = 1; i < imp.level; i++) dir = path.posix.dirname(dir);
    base = dir === "." ? "" : dir;
  }
  const join = (...p) => path.posix.join(...p.filter(Boolean));
  const exact = imp.level > 0;

  const modFile = findPyModule(join(base, modPath), file, fileSet, exact);
  if (modFile) results.add(modFile);

  // "from pkg import submodule" may refer to pkg/submodule.py
  for (const n of imp.names) {
    const sub = findPyModule(join(base, modPath, n), file, fileSet, exact);
    if (sub) results.add(sub);
  }

  results.delete(file);
  return [...results];
}

// -------------------------
// CONVERT INDEX → GRAPH
// -------------------------
export function indexToGraph(index) {
  const fileList = Object.keys(index);
  const fileSet = new Set(fileList);

  const nodes = fileList.map(id => ({
    id,
    lines: index[id].lines || 0
  }));
  
  const links = [];
  const seen = new Set();
  const backLinks = {};
  const addLink = (source, target) => {
    const key = source + "\u0000" + target;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source, target });
    (backLinks[target] ||= []).push(source);
  };

  for (const file of fileList) {
    for (const imp of index[file].imports) {
      const resolved = resolveImport(file, imp, fileSet);
      if (resolved && resolved !== file) addLink(file, resolved);
    }
    for (const imp of index[file].pyImports || []) {
      for (const target of resolvePyImport(file, imp, fileSet)) addLink(file, target);
    }
  }

  return {
    nodes,
    links,
    backLinks,
  };
}

// -------------------------
// SHARED STATE
// -------------------------
const ragIndex = new RagIndex();
let ragBuild = null; // Promise while the index is being built
let currentGraph = null;
let currentRepo = null;
let analyzeInFlight = false;

function buildRagIndexInBackground() {
  ragBuild = new Promise((resolve) => {
    setImmediate(() => {
      try {
        const t0 = Date.now();
        const info = ragIndex.build(TEMP_DIR, currentGraph);
        console.log(`RAG index: ${info.chunks} chunks in ${Date.now() - t0}ms`);
      } catch (e) {
        console.error("RAG index build failed:", e);
      }
      resolve();
    });
  }).finally(() => {
    ragBuild = null;
  });
  return ragBuild;
}

// -------------------------
// MAIN ROUTE
// -------------------------
app.post("/analyze", analyzeLimiter, async (req, res) => {
  const repoUrl = normalizeRepoUrl(req.body?.repoUrl);

  if (!repoUrl) {
    return res.status(400).json({
      success: false,
      error: "Please provide a public GitHub repository URL like https://github.com/owner/repo",
    });
  }
  if (analyzeInFlight) {
    return res.status(409).json({ success: false, error: "Another analysis is running. Try again in a few seconds." });
  }

  analyzeInFlight = true;
  const t0 = Date.now();
  try {
    await cloneRepo(repoUrl);

    const index = buildIndex(TEMP_DIR);
    const graph = indexToGraph(index);
    const diagnostics = analyzeGraphDiagnostics(graph.nodes, graph.links);

    let endpoints = [];
    try {
      endpoints = discoverEndpoints(TEMP_DIR);
    } catch (e) {
      console.error("Endpoint discovery failed:", e);
    }
    endpointCache = endpoints;
    endpointCacheDir = TEMP_DIR;

    currentGraph = graph;
    currentRepo = repoUrl;
    buildRagIndexInBackground();

    return res.json({
      success: true,
      repoUrl,
      graph,
      diagnostics,
      endpoints,
      stats: { files: graph.nodes.length, links: graph.links.length, ms: Date.now() - t0 },
    });
  } catch (err) {
    console.error(err);
    const notFound = /not found|repository .* does not exist|could not read/i.test(err.message || "");
    return res.status(notFound ? 404 : 500).json({
      success: false,
      graph: { nodes: [], links: [], backLinks: {} },
      diagnostics: null,
      error: notFound ? "Repository not found or not public." : err.message,
    });
  } finally {
    analyzeInFlight = false;
  }
});

// -------------------------
// FILE CONTENT
// -------------------------
// Cache endpoint analysis per repo clone
let endpointCache = null;
let endpointCacheDir = null;

// -------------------------
// ENDPOINT DISCOVERY
// -------------------------
app.get("/endpoints", async (req, res) => {
  try {
    if (!fs.existsSync(TEMP_DIR)) {
      return res.json({ endpoints: [], note: "No repository analyzed yet." });
    }

    // Use cached results if the temp directory hasn't changed
    if (endpointCache && endpointCacheDir === TEMP_DIR && fs.existsSync(TEMP_DIR)) {
      return res.json({ endpoints: endpointCache, note: null });
    }

    const endpoints = discoverEndpoints(TEMP_DIR);
    endpointCache = endpoints;
    endpointCacheDir = TEMP_DIR;

    return res.json({ endpoints, note: endpoints.length === 0 ? "No discoverable endpoints found in this repository." : null });
  } catch (err) {
    console.error("Endpoint discovery error:", err);
    return res.status(500).json({ error: "Endpoint discovery failed.", message: err.message });
  }
});

// -------------------------
// FLOW TRACING
// -------------------------
app.get("/flow", async (req, res) => {
  try {
    const { method, path: routePath } = req.query;
    if (!routePath) {
      return res.status(400).json({ error: "Missing 'path' parameter." });
    }

    if (!fs.existsSync(TEMP_DIR)) {
      return res.status(404).json({ error: "No repository analyzed yet." });
    }

    // Get or build endpoints
    let endpoints = endpointCache;
    if (!endpoints || endpointCacheDir !== TEMP_DIR) {
      endpoints = discoverEndpoints(TEMP_DIR);
      endpointCache = endpoints;
      endpointCacheDir = TEMP_DIR;
    }

    // Find matching endpoint by method and path
    const normalizedQueryPath = routePath.startsWith("/") ? routePath : "/" + routePath;
    let selected = endpoints.find(
      (ep) =>
        (ep.path === normalizedQueryPath || ep.path === routePath) &&
        (method ? ep.method === method.toUpperCase() : true)
    );

    // If no exact match, try partial path match
    if (!selected) {
      selected = endpoints.find(
        (ep) =>
          (ep.path.includes(normalizedQueryPath) || normalizedQueryPath.includes(ep.path)) &&
          (method ? ep.method === method.toUpperCase() : true)
      );
    }

    if (!selected) {
      // Return partial info with no trace
      return res.json({
        entry: null,
        paths: [],
        partial: true,
        note: `No endpoint found for method=${method || "any"}, path=${routePath}`,
        endpoints: endpoints.slice(0, 20),
      });
    }

    const result = traceFlow([selected], TEMP_DIR, 4, 30);
    return res.json({
      entry: result.entry,
      paths: result.paths,
      partial: result.partial,
      note: result.note,
      endpoint: result.endpoint,
    });
  } catch (err) {
    console.error("Flow tracing error:", err);
    return res.status(500).json({ error: "Flow tracing failed.", message: err.message });
  }
});

app.get("/file", async (req, res) => {
  const filePath = String(req.query.path || "");
  const full = path.resolve(TEMP_DIR, filePath);

  // Block path traversal outside the cloned repository.
  if (!filePath || !full.startsWith(path.resolve(TEMP_DIR) + path.sep)) {
    return res.status(400).json({ content: "", error: "Invalid path." });
  }

  try {
    const content = await fs.readFile(full, "utf8");
    res.json({ content });
  } catch (err) {
    res.status(404).json({ content: "", error: "File not found." });
  }
});

// -------------------------
// DIAGNOSTICS
// -------------------------
app.post("/diagnostics", async (req, res) => {
  try {
    const { nodes = [], links = [] } = req.body || {};
    const diagnostics = analyzeGraphDiagnostics(nodes, links);
    return res.json(diagnostics);
  } catch (err) {
    console.error("Diagnostics error:", err);
    return res.status(500).json({ error: "Diagnostics failed.", message: err.message });
  }
});

// -------------------------
// RAG Q&A
// -------------------------
app.get("/ask/status", (req, res) => {
  res.json({
    ready: ragIndex.ready,
    building: Boolean(ragBuild),
    chunks: ragIndex.store.size,
    repoUrl: currentRepo,
    llm: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: MODEL,
  });
});

app.post("/ask", askLimiter, async (req, res) => {
  const question = String(req.body?.question || "").trim();
  const wantsStream = req.body?.stream === true || /text\/event-stream/.test(req.get("accept") || "");

  if (!question) return res.status(400).json({ error: "Question is required." });
  if (question.length > 2000) return res.status(400).json({ error: "Question is too long (max 2000 characters)." });

  if (!ragIndex.ready) {
    if (ragBuild) await ragBuild;
    else if (fs.existsSync(TEMP_DIR) && currentGraph) await buildRagIndexInBackground();
  }
  if (!ragIndex.ready) {
    return res.status(409).json({ error: "Analyze a repository first, then ask questions about it." });
  }

  if (!wantsStream) {
    try {
      const result = await answerQuestion(ragIndex, question);
      return res.json(result);
    } catch (err) {
      console.error("Ask error:", err);
      return res.status(502).json({ error: describeError(err) });
    }
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const result = await answerQuestion(ragIndex, question, send);
    send({ type: "done", mode: result.mode, model: result.model || null });
  } catch (err) {
    console.error("Ask stream error:", err);
    send({ type: "error", error: describeError(err) });
  } finally {
    res.end();
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

export { app };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}
