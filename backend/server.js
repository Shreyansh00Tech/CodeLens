import "./env.js";
import express from "express";
import { simpleGit } from "simple-git";
import path from "path";
import fs from "fs-extra";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { analyzeGraphDiagnostics } from "./graphDiagnostics.js";
import { Project, discoverEndpointsInProject, traceEndpoint, publicEndpoint, callSitesInto } from "./endpoints.js";
import { RagIndex, answerQuestion, describeError, MODEL } from "./rag/ragAgent.js";
import { fileURLToPath } from "url";

const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy / load balancer, set TRUST_PROXY (e.g. "1") so rate
// limiting sees the real client IP instead of the proxy's.
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(v) ? Number(v) : v === "true" ? true : v);
}

// CORS: comma-separated allow-list in CORS_ORIGINS; unset = allow any origin (local development).
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors(CORS_ORIGINS.length ? { origin: CORS_ORIGINS } : undefined));
app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  next();
});

const PORT = process.env.PORT || 8080;
const MAX_INDEX_FILES = Number(process.env.CODELENS_MAX_FILES) || 8000; // source files indexed per repository
const MAX_FILE_BYTES = 1_500_000; // skip minified bundles / generated blobs
const CLONE_TIMEOUT_MS = 90_000;
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
  max: 10,
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

/**
 * A cloned repo is untrusted input. Symlinks are deleted so that no reader
 * (indexer, RAG chunker, /file) can be tricked into following one to a file
 * outside the clone, for example `a.js -> /etc/passwd`.
 */
export function stripSymlinks(dir) {
  let removed = 0;
  const walk = (folder) => {
    let items;
    try {
      items = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(folder, item.name);
      if (item.isSymbolicLink()) {
        try {
          fs.unlinkSync(full);
          removed++;
        } catch {
          /* best effort */
        }
      } else if (item.isDirectory() && item.name !== ".git") {
        walk(full);
      }
    }
  };
  walk(dir);
  return removed;
}

/** Map a git failure to a status + a message that never leaks server paths or raw git output. */
export function describeCloneError(err) {
  const msg = String(err?.message || "");
  if (/not found|does not exist|could not read|authentication failed|invalid username|terminal prompts disabled|access denied|403/i.test(msg)) {
    return { status: 404, error: "Repository not found or not public." };
  }
  if (/timeout|timed out/i.test(msg)) {
    return { status: 504, error: "Cloning took too long. Try a smaller repository." };
  }
  return { status: 500, error: "Could not analyze this repository. Please try again." };
}

/**
 * Minimal environment for git: enough to find the binary and reach the network
 * (proxy + CA settings), never the server's secrets (API keys) or editor/askpass hooks.
 */
export function gitEnv(env = process.env) {
  const keep = ["PATH", "HOME", "LANG", "TMPDIR", "SYSTEMROOT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"];
  const out = {};
  for (const k of keep) if (env[k]) out[k] = env[k];
  out.GIT_TERMINAL_PROMPT = "0"; // private repos fail fast instead of waiting on a credentials prompt
  return out;
}

async function cloneRepo(repoUrl) {
  await fs.remove(TEMP_DIR);
  await fs.mkdir(TEMP_DIR);

  // Never wait on a credentials prompt (private repos) and never hang on a stalled transfer.
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS }, allowEnvironment: ["GIT_SSL_CAINFO", "GIT_TERMINAL_PROMPT"] }).env(gitEnv());
  await git.clone(repoUrl, TEMP_DIR, ["--depth", "1", "--single-branch", "--no-tags"]);
  stripSymlinks(TEMP_DIR);
}

// Marker key set on an index that hit the file limit (not a real file path).
const TRUNCATED = "\u0000truncated";

// -------------------------
// FAST INDEXER 
// -------------------------
export function buildIndex(dir, maxFiles = MAX_INDEX_FILES) {
  const index = {};
  let count = 0;

  function walk(folder) {
    let items;
    try {
      items = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (count >= maxFiles) {
        index[TRUNCATED] = true;
        return;
      }
      if (IGNORE.has(item.name) || item.isSymbolicLink()) continue;

      const fullPath = path.join(folder, item.name);

      if (item.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!item.name.match(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/)) continue;

      try {
        if (fs.statSync(fullPath).size > MAX_FILE_BYTES) continue;
        const content = fs.readFileSync(fullPath, "utf8");

        const imports = item.name.endsWith(".py")
          ? extractPythonImports(content)
          : [
              ...content.matchAll(/from\s+['"](.*?)['"]/g),
              ...content.matchAll(/require\(['"](.*?)['"]\)/g),
              ...content.matchAll(/import\(\s*['"](.*?)['"]\s*\)/g),
              ...content.matchAll(/^\s*import\s+['"](.*?)['"]/gm),
            ].map(m => m[1]);

        const rel = path.relative(dir, fullPath).replace(/\\/g, "/");

        // Line count calculate kar rahe hain (Health Score aur Dead Code Metrics ke liye)
        const lines = content.split('\n').length;

        index[rel] = {
          imports: [...new Set(imports)].slice(0, 200),
          lines: lines
        };
        count++;

      } catch (e) {
        // Skip unreadable files
      }
    }
  }

  walk(dir);
  return index;
}

// -------------------------
// PYTHON IMPORTS
// -------------------------
// Stored as "py:<dots><dotted.module>" so the resolver can tell them from JS specifiers.
export function extractPythonImports(content) {
  const out = new Set();
  const names = (raw) =>
    raw
      .replace(/#.*$/gm, "")
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0])
      .filter((n) => /^\w+$/.test(n));

  for (const m of content.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const [, dots, mod, rest] = m;
    if (!dots && !mod) continue;
    if (mod) out.add(`py:${dots}${mod}`);
    // `from pkg import sub` may import the submodule pkg/sub.py
    for (const n of names(rest)) out.add(`py:${dots}${mod ? mod + "." : ""}${n}`);
  }
  for (const m of content.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) out.add(`py:${name}`);
    }
  }
  return [...out];
}

const pyIndexCache = new WeakMap();
function pythonModuleIndex(allFiles) {
  let idx = pyIndexCache.get(allFiles);
  if (idx) return idx;
  idx = new Map(); // dotted-path suffix -> files
  for (const f of allFiles) {
    if (!f.endsWith(".py")) continue;
    const segs = f.slice(0, -3).split("/");
    if (segs[segs.length - 1] === "__init__") segs.pop();
    for (let i = 0; i < segs.length; i++) {
      const key = segs.slice(i).join("/");
      if (!idx.has(key)) idx.set(key, []);
      idx.get(key).push(f);
    }
  }
  pyIndexCache.set(allFiles, idx);
  return idx;
}

function sharedDirDepth(a, b) {
  const x = a.split("/").slice(0, -1);
  const y = b.split("/").slice(0, -1);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

export function resolvePythonImport(file, spec, allFiles) {
  const body = spec.slice(3);
  const dots = body.match(/^\.*/)[0].length;
  const parts = body.slice(dots).split(".").filter(Boolean);
  const candidates = (p) => (p ? [`${p}.py`, `${p}/__init__.py`] : []);

  if (dots > 0) {
    let base = path.posix.dirname(file);
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    const target = path.posix.normalize(parts.length ? path.posix.join(base, ...parts) : base);
    if (!parts.length) {
      const init = path.posix.join(target === "." ? "" : target, "__init__.py");
      return allFiles.has(init) ? init : null;
    }
    return candidates(target).find((c) => allFiles.has(c)) || null;
  }

  const joined = parts.join("/");
  const direct = candidates(joined).find((c) => allFiles.has(c));
  if (direct) return direct;
  const matches = pythonModuleIndex(allFiles).get(joined) || [];
  if (!matches.length) return null;
  return [...matches].sort((a, b) => sharedDirDepth(file, b) - sharedDirDepth(file, a) || a.localeCompare(b))[0];
}

export function resolveImport(file, imp, allFiles) {
  if (imp.startsWith("py:")) return resolvePythonImport(file, imp, allFiles);
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
// CONVERT INDEX → GRAPH
// -------------------------
export function indexToGraph(index) {
  const fileList = Object.keys(index).filter((k) => k !== TRUNCATED);
  const fileSet = new Set(fileList);

  const nodes = fileList.map(id => ({
    id,
    lines: index[id].lines || 0
  }));
  
  const links = [];
  const seen = new Set();

  for (const file of fileList) {
    for (const imp of index[file].imports) {
      const resolved = resolveImport(file, imp, fileSet);

      if (resolved && resolved !== file) {
        const key = `${file}\u0000${resolved}`;
        if (seen.has(key)) continue; // one edge per file pair, however many ways it is imported
        seen.add(key);
        links.push({
          source: file,
          target: resolved,
        });
      }
    }
  }

  return {
    nodes,
    links,
    backLinks: {},
    truncated: Boolean(index[TRUNCATED]),
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
        const info = ragIndex.build(TEMP_DIR, currentGraph, { flow: () => getFlowIndex(), traceEndpoint, callSitesInto });
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
  // The previous clone is about to be replaced: drop everything derived from it so no
  // endpoint, file or Ask AI answer is ever served from a repository that no longer exists.
  currentGraph = null;
  currentRepo = null;
  flowIndex = null;
  ragIndex.clear();
  try {
    await cloneRepo(repoUrl);

    const index = buildIndex(TEMP_DIR);
    const graph = indexToGraph(index);
    const diagnostics = analyzeGraphDiagnostics(graph.nodes, graph.links);

    let endpoints = [];
    try {
      endpoints = refreshFlowIndex().endpoints.map(publicEndpoint);
    } catch (e) {
      console.error("Endpoint discovery failed:", e);
      flowIndex = null;
    }

    currentGraph = graph;
    currentRepo = repoUrl;
    buildRagIndexInBackground();

    return res.json({
      success: true,
      repoUrl,
      graph,
      diagnostics,
      endpoints,
      stats: { files: graph.nodes.length, links: graph.links.length, ms: Date.now() - t0, truncated: graph.truncated },
    });
  } catch (err) {
    const { status, error } = describeCloneError(err);
    console.error(`Analyze failed (${status}): ${String(err?.message || err).split("\n")[0].slice(0, 200)}`);
    return res.status(status).json({
      success: false,
      graph: { nodes: [], links: [], backLinks: {} },
      diagnostics: null,
      error,
    });
  } finally {
    analyzeInFlight = false;
  }
});

// -------------------------
// FILE CONTENT
// -------------------------
// Endpoint index for the current clone. Holds the parsed project so traces
// reuse ASTs; rebuilt on every /analyze.
let flowIndex = null; // { project, endpoints, byId, builtAt }

function refreshFlowIndex() {
  const project = new Project(TEMP_DIR);
  const endpoints = discoverEndpointsInProject(project);
  flowIndex = { project, endpoints, byId: new Map(endpoints.map((e) => [e.id, e])), builtAt: Date.now() };
  return flowIndex;
}

function getFlowIndex() {
  if (!currentRepo || !fs.existsSync(TEMP_DIR)) return null;
  return flowIndex || refreshFlowIndex();
}

// -------------------------
// ENDPOINT DISCOVERY
// -------------------------
app.get("/endpoints", (req, res) => {
  try {
    const idx = getFlowIndex();
    if (!idx) return res.json({ endpoints: [], note: "No repository analyzed yet." });
    return res.json({
      endpoints: idx.endpoints.map(publicEndpoint),
      truncatedFiles: idx.project.truncatedFiles,
      note: idx.endpoints.length === 0 ? "No Express, Flask or FastAPI routes were found in this repository." : null,
    });
  } catch (err) {
    console.error("Endpoint discovery error:", err);
    return res.status(500).json({ error: "Endpoint discovery failed." });
  }
});

// -------------------------
// FLOW TRACING
// -------------------------
app.get("/flow", (req, res) => {
  try {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    const routePath = typeof req.query.path === "string" ? req.query.path : "";
    const method = typeof req.query.method === "string" ? req.query.method.toUpperCase() : "";
    const depth = Math.min(12, Math.max(1, Number(req.query.depth) || 8));
    if (!id && !routePath) return res.status(400).json({ error: "Provide an endpoint 'id' or a 'path' (optionally with 'method')." });

    const idx = getFlowIndex();
    if (!idx) return res.status(404).json({ error: "No repository analyzed yet." });

    const normalized = routePath.startsWith("/") ? routePath : "/" + routePath;
    const selected = (id && idx.byId.get(id)) || (routePath && idx.endpoints.find((ep) => ep.path === normalized && (!method || ep.method === method)));
    if (!selected) {
      return res.status(404).json({ error: `No endpoint found for ${id || `${method || "ANY"} ${normalized}`}.` });
    }

    const t0 = Date.now();
    const result = traceEndpoint(idx.project, selected, { maxDepth: depth, maxNodes: 220 });
    // AST paths are internal; strip them from the serialized nodes.
    return res.json({ ...result, ms: Date.now() - t0 });
  } catch (err) {
    console.error("Flow tracing error:", err);
    return res.status(500).json({ error: "Flow tracing failed." });
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
    // Resolve symlinks before reading: the real path must still be inside the clone.
    const [real, root] = await Promise.all([fs.realpath(full), fs.realpath(TEMP_DIR)]);
    if (!real.startsWith(root + path.sep)) {
      return res.status(400).json({ content: "", error: "Invalid path." });
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) return res.status(404).json({ content: "", error: "File not found." });
    if (stat.size > MAX_FILE_BYTES) {
      return res.status(413).json({ content: "", error: "File is too large to preview." });
    }
    const content = await fs.readFile(real, "utf8");
    res.json({ content });
  } catch {
    res.status(404).json({ content: "", error: "File not found." });
  }
});

// -------------------------
// DIAGNOSTICS
// -------------------------
app.post("/diagnostics", async (req, res) => {
  try {
    const { nodes = [], links = [] } = req.body || {};
    if (!Array.isArray(nodes) || !Array.isArray(links)) {
      return res.status(400).json({ error: "`nodes` and `links` must be arrays." });
    }
    if (nodes.length > 20000 || links.length > 100000) {
      return res.status(413).json({ error: "Graph is too large to analyze." });
    }
    const diagnostics = analyzeGraphDiagnostics(nodes, links);
    return res.json(diagnostics);
  } catch (err) {
    console.error("Diagnostics error:", err.message);
    return res.status(500).json({ error: "Diagnostics failed." });
  }
});

// -------------------------
// RAG Q&A
// -------------------------
app.get("/ask/status", (req, res) => {
  res.json({
    ready: ragIndex.ready,
    building: Boolean(ragBuild) || analyzeInFlight,
    chunks: ragIndex.store.size,
    repoUrl: currentRepo,
    llm: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: MODEL,
  });
});

async function handleAsk(req, res) {
  const question = String(req.body?.question || "").trim();
  const wantsStream = req.body?.stream === true || /text\/event-stream/.test(req.get("accept") || "");

  if (!question) return res.status(400).json({ error: "Question is required." });
  if (question.length > 2000) return res.status(400).json({ error: "Question is too long (max 2000 characters)." });
  if (req.body?.history !== undefined && !Array.isArray(req.body.history)) return res.status(400).json({ error: "history must be an array." });
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-20) : [];

  if (!ragIndex.ready) {
    if (ragBuild) await ragBuild;
    else if (fs.existsSync(TEMP_DIR) && currentGraph) await buildRagIndexInBackground();
  }
  if (!ragIndex.ready) {
    if (analyzeInFlight) return res.status(409).json({ error: "A repository is being analyzed right now. Ask again in a few seconds." });
    return res.status(409).json({ error: "Analyze a repository first, then ask questions about it." });
  }

  if (!wantsStream) {
    try {
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const result = await answerQuestion(ragIndex, question, () => {}, { signal: abort.signal, history });
      return res.json(result);
    } catch (err) {
      if (res.destroyed) return;
      console.error("Ask error:", describeError(err));
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
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort(); // tab closed: stop paying for the generation
  });
  const send = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const result = await answerQuestion(ragIndex, question, send, { signal: abort.signal, history });
    send({ type: "done", mode: result.mode, model: result.model || null });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error("Ask stream error:", describeError(err));
      send({ type: "error", error: describeError(err) });
    }
  } finally {
    res.end();
  }
}

// Legacy route plus the versioned REST route. The server analyses one repository at a
// time, so `:id` is accepted for API-shape compatibility and the active repo is queried.
app.post("/ask", askLimiter, handleAsk);
app.post("/api/v1/repos/:id/ask", askLimiter, handleAsk);
app.get("/api/v1/repos/:id/ask/status", (req, res) => res.redirect(307, "/ask/status"));

app.get("/health", (req, res) => res.json({ ok: true, repo: Boolean(currentRepo), ai: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) }));

// -------------------------
// OPTIONAL: SERVE THE FRONTEND BUILD
// -------------------------
// SERVE_FRONTEND=true serves ../frontend/dist (or SERVE_FRONTEND=/path/to/dist), so a single
// process can host the whole app. API routes above take precedence; unknown GET routes that
// ask for HTML get index.html so client-side routes (/analyze, /docs, …) work on reload.
const FRONTEND_DIR = !process.env.SERVE_FRONTEND
  ? null
  : process.env.SERVE_FRONTEND === "true"
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../frontend/dist")
    : path.resolve(process.env.SERVE_FRONTEND);
if (FRONTEND_DIR) {
  if (!fs.existsSync(path.join(FRONTEND_DIR, "index.html"))) {
    console.warn(`SERVE_FRONTEND is set but ${FRONTEND_DIR}/index.html does not exist; build the frontend first.`);
  } else {
    app.use(express.static(FRONTEND_DIR, { index: false, maxAge: "1h", setHeaders: (res, file) => {
      if (/[\\/]assets[\\/]/.test(file)) res.set("Cache-Control", "public, max-age=31536000, immutable");
    } }));
    app.get(/.*/, (req, res, next) => {
      if (!req.accepts("html")) return next();
      res.set("Cache-Control", "no-cache");
      res.sendFile(path.join(FRONTEND_DIR, "index.html"));
    });
  }
}

// Unknown API routes: JSON 404 instead of Express's HTML page.
app.use((req, res) => res.status(404).json({ error: "Not found." }));

// Bad JSON / oversized bodies get a JSON answer instead of an HTML stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  const error =
    err.type === "entity.parse.failed" ? "Invalid JSON body."
    : status === 413 ? "Request body too large."
    : status >= 500 ? "Internal server error."
    : err.message || "Bad request.";
  res.status(status).json({ error });
});

export { app };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
}
