/**
 * Structural knowledge about the analyzed repository, for Ask AI.
 *
 * Text retrieval alone answers "what does this code say?" well, but not
 * "where does the app start?", "what's the architecture?" or "what breaks if
 * I change X?". This module answers those from CodeLens's own analysis: the
 * import graph, the endpoint index and flow tracer, a symbol index and
 * call-site search. Every fact carries a [file:Lx-Ly] citation; nothing here
 * is generated, so the same facts serve as grounding for Claude and as the
 * offline answer when no API key is configured.
 */
import fs from "fs";
import path from "path";

const CODE_RE = /\.(m?js|cjs|jsx|ts|tsx|py)$/;
const MAX_FILE_BYTES = 400 * 1024;

const STOPWORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "what", "where", "which", "does", "how", "into", "when", "why",
  "explain", "project", "repository", "repo", "codebase", "code", "file", "files", "function", "functions", "class",
  "method", "module", "app", "application", "work", "works", "between", "relationship", "modify", "change", "break",
  "could", "would", "should", "about", "show", "tell", "make", "makes", "happen", "happens", "endpoint", "api", "route",
  "routes", "used", "uses", "call", "calls", "called", "start", "starts", "particular", "component", "components",
  "feature", "responsible", "handle", "handles", "interact", "interacts", "other", "overall", "architecture", "main",
  "index", "test", "tests", "src", "lib", "get", "set", "new", "data", "user", "users",
]);

const LAYER_HINTS = [
  [/(^|\/)routes?(\/|$)|router/i, "routing"],
  [/(^|\/)controllers?(\/|$)/i, "controllers (HTTP handlers)"],
  [/(^|\/)services?(\/|$)/i, "services (business logic)"],
  [/(^|\/)(models?|entities|schemas?)(\/|$)/i, "data models"],
  [/(^|\/)(repositor(y|ies)|dao|db|database)(\/|$)/i, "data access"],
  [/(^|\/)middlewares?(\/|$)/i, "middleware"],
  [/(^|\/)(utils?|helpers?|lib)(\/|$)/i, "utilities"],
  [/(^|\/)config(\/|$)/i, "configuration"],
  [/(^|\/)(tests?|__tests__|spec)(\/|$)/i, "tests"],
  [/(^|\/)(components?)(\/|$)/i, "UI components"],
  [/(^|\/)(pages?|views?|screens?)(\/|$)/i, "pages / views"],
  [/(^|\/)(hooks?)(\/|$)/i, "React hooks"],
  [/(^|\/)(validations?|validators?)(\/|$)/i, "validation"],
  [/(^|\/)(docs?)(\/|$)/i, "documentation"],
];

const FRAMEWORKS = [
  ["express", "Express"], ["fastify", "Fastify"], ["koa", "Koa"], ["@nestjs/core", "NestJS"], ["next", "Next.js"],
  ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["@angular/core", "Angular"], ["vite", "Vite"],
  ["mongoose", "Mongoose (MongoDB)"], ["sequelize", "Sequelize"], ["@prisma/client", "Prisma"], ["typeorm", "TypeORM"],
  ["pg", "PostgreSQL client"], ["mysql2", "MySQL client"], ["redis", "Redis"], ["ioredis", "Redis"], ["passport", "Passport"],
  ["jsonwebtoken", "JWT"], ["socket.io", "Socket.IO"], ["graphql", "GraphQL"], ["jest", "Jest"], ["d3", "D3"],
  ["@supabase/supabase-js", "Supabase"], ["@anthropic-ai/sdk", "Anthropic SDK"], ["tailwindcss", "Tailwind CSS"],
];
const PY_FRAMEWORKS = [["flask", "Flask"], ["fastapi", "FastAPI"], ["django", "Django"], ["sqlalchemy", "SQLAlchemy"], ["celery", "Celery"], ["pytest", "pytest"]];

const cite = (file, a, b) => `[${file}:L${a}${b && b !== a ? `-L${b}` : ""}]`;

export class CodeKnowledge {
  /**
   * @param {{ repoDir: string, graph: {nodes: {id:string}[], links: {source:any,target:any}[]}, flow?: () => ({ project, endpoints }|null), traceEndpoint?: Function }} opts
   */
  constructor({ repoDir, graph, flow, traceEndpoint, callSitesInto }) {
    this.repoDir = repoDir;
    this.callSitesInto = callSitesInto || null;
    this.flow = flow || (() => null);
    this.traceEndpoint = traceEndpoint || null;
    this.files = (graph?.nodes || []).map((n) => n.id);
    this.fileSet = new Set(this.files);
    this.imports = new Map(); // file -> Set(file it imports)
    this.importedBy = new Map(); // file -> Set(files importing it)
    for (const l of graph?.links || []) {
      const s = typeof l.source === "string" ? l.source : l.source?.id;
      const t = typeof l.target === "string" ? l.target : l.target?.id;
      if (!s || !t) continue;
      if (!this.imports.has(s)) this.imports.set(s, new Set());
      if (!this.importedBy.has(t)) this.importedBy.set(t, new Set());
      this.imports.get(s).add(t);
      this.importedBy.get(t).add(s);
    }
    this._lines = new Map();
    this._symbols = null;
    this._overview = null;
  }

  // ---------------------------------------------------------------- io

  lines(file) {
    if (this._lines.has(file)) return this._lines.get(file);
    let out = null;
    try {
      const full = path.join(this.repoDir, file);
      const real = fs.realpathSync(full);
      if (real.startsWith(fs.realpathSync(this.repoDir) + path.sep) && fs.statSync(real).size <= MAX_FILE_BYTES) {
        out = fs.readFileSync(real, "utf8").split("\n");
      }
    } catch {
      out = null;
    }
    this._lines.set(file, out);
    return out;
  }

  codeFiles() {
    return this.files.filter((f) => CODE_RE.test(f));
  }

  // ---------------------------------------------------------------- symbols

  /** name(lowercase) -> [{ name, file, line, kind }] */
  symbols() {
    if (this._symbols) return this._symbols;
    const idx = new Map();
    const add = (name, file, line, kind) => {
      if (!name || name.length < 2 || /^(if|for|while|switch|catch|return|function|constructor|super)$/.test(name)) return;
      const k = name.toLowerCase();
      if (!idx.has(k)) idx.set(k, []);
      const list = idx.get(k);
      if (list.length < 12 && !list.some((s) => s.file === file && s.line === line)) list.push({ name, file, line, kind });
    };
    for (const file of this.codeFiles()) {
      const ls = this.lines(file);
      if (!ls) continue;
      const py = file.endsWith(".py");
      ls.forEach((l, i) => {
        let m;
        if (py) {
          if ((m = l.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/))) add(m[1], file, i + 1, "function");
          else if ((m = l.match(/^\s*class\s+([A-Za-z_]\w*)/))) add(m[1], file, i + 1, "class");
          return;
        }
        if ((m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) add(m[1], file, i + 1, "function");
        else if ((m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) add(m[1], file, i + 1, "class");
        else if ((m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) add(m[1], file, i + 1, "function");
        else if ((m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/))) add(m[1], file, i + 1, "function");
        else if ((m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\(\s*(?:async\s*)?\(/))) add(m[1], file, i + 1, "function");
        else if ((m = l.match(/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) add(m[1], file, i + 1, "type");
        else if ((m = l.match(/^\s+(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/))) add(m[1], file, i + 1, "method");
      });
    }
    this._symbols = idx;
    return idx;
  }

  /** Text references to a symbol across code files (excluding its definitions). */
  references(name, defs, limit = 40) {
    const re = new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
    const out = [];
    for (const file of this.codeFiles()) {
      const ls = this.lines(file);
      if (!ls) continue;
      for (let i = 0; i < ls.length && out.length < limit; i++) {
        const l = ls[i];
        if (!re.test(l)) continue;
        if (defs.some((d) => d.file === file && d.line === i + 1)) continue;
        if (/^\s*(\/\/|\*|#)/.test(l)) continue;
        out.push({ file, line: i + 1, text: l.trim().slice(0, 160), call: new RegExp(`${name.replace(/[$]/g, "\\$")}\\s*\\(`).test(l), import: /\b(import|require)\b/.test(l) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- entity resolution

  /** Files and symbols the question mentions, best first. */
  resolveEntities(question) {
    const syms = this.symbols();
    const found = { symbols: [], files: [] };
    const seenSym = new Set();
    const seenFile = new Set();
    const addFile = (f) => { if (f && !seenFile.has(f)) { seenFile.add(f); found.files.push(f); } };
    const addSym = (s) => {
      const key = `${s.file}:${s.line}`;
      if (seenSym.has(key)) return;
      seenSym.add(key);
      found.symbols.push(s);
    };

    // Explicit paths / file names
    for (const m of question.matchAll(/[\w./-]+\.(?:m?js|cjs|jsx|tsx?|py|json|ya?ml|md)\b/g)) {
      const tok = m[0].replace(/^\.?\//, "");
      const hit = this.files.find((f) => f === tok) || this.files.find((f) => f.endsWith("/" + tok)) || this.files.find((f) => path.posix.basename(f) === path.posix.basename(tok));
      addFile(hit);
    }
    // Identifiers: backticked, call-shaped, camelCase/snake_case, or plain words matching a known symbol
    const words = [...question.matchAll(/`([^`]+)`|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(\))?/g)].map((m) => (m[1] || m[2] || "").replace(/\(\)$/, ""));
    for (const w of words) {
      if (!w) continue;
      const parts = w.split(".");
      const last = parts[parts.length - 1];
      const lower = last.toLowerCase();
      const strong = /[a-z][A-Z]|_/.test(last) || parts.length > 1 || w !== w.toLowerCase();
      if (STOPWORDS.has(lower) || lower.length < 3) continue;
      if (!strong && lower.length < 5) continue;
      const defs = syms.get(lower);
      if (defs) defs.slice(0, 4).forEach(addSym);
      // file basenames: "auth controller" style handled below; here a word equal to a module name
      for (const f of this.files) {
        const base = path.posix.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
        if (base === lower || base.replace(/[._-]/g, "") === lower.replace(/[._-]/g, "")) addFile(f);
      }
    }
    // Adjacent word pairs: "auth service" -> auth.service.js / authService
    const plain = question.toLowerCase().match(/[a-z0-9_]+/g) || [];
    for (let i = 0; i + 1 < plain.length; i++) {
      const [a, b] = [plain[i], plain[i + 1]];
      if (STOPWORDS.has(a) && STOPWORDS.has(b)) continue;
      for (const f of this.files) {
        const base = path.posix.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
        if (base === `${a}.${b}` || base === `${a}_${b}` || base === `${a}-${b}` || base === `${a}${b}`) addFile(f);
      }
      const camel = syms.get(`${a}${b}`);
      if (camel) camel.slice(0, 2).forEach(addSym);
    }
    for (const s of found.symbols) addFile(s.file);
    found.symbols = found.symbols.slice(0, 6);
    found.files = found.files.slice(0, 8);
    return found;
  }

  findEndpoint(question) {
    const idx = this.flow();
    if (!idx?.endpoints?.length) return null;
    const eps = idx.endpoints;
    const m = question.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?`'"]*)/i);
    if (m) {
      const method = m[1].toUpperCase();
      const p = m[2].replace(/[.,;:!?)]+$/, "");
      return eps.find((e) => e.method === method && e.path === p) || eps.find((e) => e.method === method && e.path.endsWith(p)) || null;
    }
    const pm = question.match(/(\/[\w:{}<>.\-/]+)/);
    if (pm) {
      const p = pm[1].replace(/[.,;:!?)]+$/, "");
      const hits = eps.filter((e) => e.path === p || e.path.endsWith(p));
      if (hits.length) return hits.find((e) => e.method === "GET") || hits[0];
    }
    if (/\b(endpoint|route|api|request)\b/i.test(question)) {
      const words = (question.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOPWORDS.has(w));
      let best = null;
      for (const e of eps) {
        const segs = e.path.toLowerCase().split(/[/:{}<>-]+/).filter(Boolean);
        const score = words.filter((w) => segs.includes(w)).length;
        if (score && (!best || score > best.score || (score === best.score && e.path.length < best.e.path.length))) best = { e, score };
      }
      return best?.e || null;
    }
    return null;
  }

  // ---------------------------------------------------------------- overview

  overview() {
    if (this._overview) return this._overview;
    const o = { packages: [], frameworks: new Set(), readme: null, dirs: [], hubs: [], entries: this.entryPoints(), layerEdges: [] };

    // package manifests (root and one level down for monorepos)
    const manifests = this.findFiles((f) => /(^|\/)package\.json$/.test(f) && f.split("/").length <= 2 && !f.includes("node_modules"));
    for (const f of manifests) {
      const ls = this.lines(f);
      if (!ls) continue;
      try {
        const pkg = JSON.parse(ls.join("\n"));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const [k, label] of FRAMEWORKS) if (deps[k]) o.frameworks.add(label);
        o.packages.push({ file: f, name: pkg.name, description: pkg.description, main: pkg.main, scripts: pkg.scripts || {}, lineOf: (key) => ls.findIndex((l) => l.includes(`"${key}"`)) + 1 });
      } catch {
        // invalid JSON: ignore
      }
    }
    for (const f of this.findFiles((f) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(f))) {
      const text = (this.lines(f) || []).join("\n").toLowerCase();
      for (const [k, label] of PY_FRAMEWORKS) if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(text)) o.frameworks.add(label);
    }

    const readme = this.findFiles((f) => /^readme\.(md|rst|txt)$/i.test(f))[0];
    if (readme) {
      const ls = this.lines(readme) || [];
      for (let i = 0; i < Math.min(ls.length, 60); i++) {
        const t = ls[i].trim();
        if (!t || /^(#|!\[|\[!\[|<|>|```|\||-{3,}|=+)/.test(t) || t.length < 40) continue;
        o.readme = { file: readme, line: i + 1, text: t.replace(/\*\*/g, "").slice(0, 280) };
        break;
      }
    }

    // directory structure
    const dirCount = new Map();
    for (const f of this.files) {
      const parts = f.split("/");
      const key = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0] : ".";
      dirCount.set(key, (dirCount.get(key) || 0) + 1);
    }
    o.dirs = [...dirCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([dir, n]) => ({ dir, files: n, role: (LAYER_HINTS.find(([re]) => re.test(dir + "/")) || [])[1] || null }));

    o.hubs = [...this.importedBy.entries()].map(([f, s]) => ({ file: f, fanIn: s.size, fanOut: this.imports.get(f)?.size || 0 })).sort((a, b) => b.fanIn - a.fanIn).slice(0, 6);

    // directory-level dependency summary
    const dirOf = (f) => { const p = f.split("/"); return p.length > 2 ? p.slice(0, 2).join("/") : p.length === 2 ? p[0] : "."; };
    const le = new Map();
    for (const [s, ts] of this.imports) for (const t of ts) {
      const a = dirOf(s); const b = dirOf(t);
      if (a === b) continue;
      const k = `${a}\u0000${b}`;
      le.set(k, (le.get(k) || 0) + 1);
    }
    o.layerEdges = [...le.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => { const [from, to] = k.split("\u0000"); return { from, to, n }; });
    o.frameworks = [...o.frameworks];
    this._overview = o;
    return o;
  }

  findFiles(pred) {
    // Graph nodes only include code files; manifests and docs are found on disk (top two levels).
    const out = [];
    const walk = (dir, depth) => {
      let items;
      try { items = fs.readdirSync(path.join(this.repoDir, dir), { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if ((it.name.startsWith(".") && it.name !== ".flaskenv") || it.name === "node_modules") continue;
        const rel = dir ? `${dir}/${it.name}` : it.name;
        if (it.isFile() && pred(rel)) out.push(rel);
        else if (it.isDirectory() && depth < 1) walk(rel, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }

  entryPoints() {
    const out = [];
    const PATTERNS = [
      // `.listen(` on something that looks like a server/app (not e.g. SQLAlchemy's db.event.listen)
      [/\b(?:app|server|httpServer|httpsServer|srv|fastify|instance|[a-z]\w*(?:Server|App))\.listen\s*\(/, "starts the HTTP server (.listen)"],
      [/\bcreateServer\s*\(/, "creates an HTTP server"],
      [/\b(app|application)\.run\s*\(/, "runs the app (app.run)"],
      [/\buvicorn\.run\s*\(/, "starts the ASGI server (uvicorn.run)"],
      [/__name__\s*==\s*['"]__main__['"]/, "script entry (__main__)"],
      [/^\s*\w+\s*=\s*(?:Flask|FastAPI)\s*\(/, "creates the web application object"],
      [/^\s*def\s+create_app\s*\(/, "application factory (create_app)"],
      [/^\s*\w+\s*=\s*create_app\s*\(/, "builds the application with create_app()"],
      [/\b(createRoot|hydrateRoot)\s*\(|ReactDOM\.render\s*\(/, "mounts the React app"],
      [/\bcreateApp\s*\([^)]*\)\s*\.mount\s*\(/, "mounts the Vue app"],
    ];
    const isTest = (f) => /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.|(^|\/)(test_[^/]*|[^/]*_test|tests|conftest)\.py$/.test(f);
    for (const file of this.codeFiles()) {
      if (isTest(file)) continue;
      const ls = this.lines(file);
      if (!ls) continue;
      for (let i = 0; i < ls.length; i++) {
        const l = ls[i];
        if (/^\s*(\/\/|\*|#(?!.*__main__))/.test(l) || /\bevent\.listen\s*\(/.test(l)) continue;
        const hit = PATTERNS.find(([re]) => re.test(l));
        if (hit && !out.some((e) => e.file === file && e.why === hit[1])) out.push({ file, line: i + 1, why: hit[1], text: l.trim().slice(0, 140) });
      }
    }
    // Process / container definitions that say how the app is launched
    const launch = this.findFiles((f) => /(^|\/)(Procfile|Dockerfile|\.flaskenv|boot\.sh|start\.sh|entrypoint\.sh|docker-entrypoint\.sh)$/.test(f));
    for (const file of launch) {
      const ls = this.lines(file) || [];
      ls.forEach((l, i) => {
        const t = l.trim();
        if (!t || t.startsWith("#")) return;
        let why = null;
        if (/Procfile$/.test(file) && /^\w+:\s*\S/.test(t)) why = `Procfile process \`${t.split(":")[0]}\``;
        else if (/Dockerfile$/.test(file) && /^(CMD|ENTRYPOINT)\b/i.test(t)) why = "container start command";
        else if (/\.flaskenv$/.test(file) && /^FLASK_APP\s*=/.test(t)) why = "Flask app module (FLASK_APP)";
        else if (/\.sh$/.test(file) && /\b(gunicorn|uvicorn|flask run|node |npm (run )?start|python[0-9.]* )/.test(t)) why = "launch script";
        if (why && out.filter((e) => e.file === file).length < 3) out.push({ file, line: i + 1, why, text: t.slice(0, 140) });
      });
    }
    return out.slice(0, 12);
  }

  // ---------------------------------------------------------------- facts per question

  /**
   * Build the structural facts relevant to a question.
   * Returns { sections: [{ title, lines }], focus: [{file, line}], intents: string[] }.
   */
  factsFor(question) {
    const q = question.toLowerCase();
    const intents = new Set();
    if (/architect|overall|structure|overview|high[- ]level|organi[sz]ed|what (is|does) (this|the) (project|repo|app|codebase)|tech stack|explain (this|the) (project|repo|codebase|app)/.test(q)) intents.add("architecture");
    if (/entry ?point|where does .*(start|begin|boot)|start(s|ed)? up|bootstrap|main file|how (do|does|to) .*(run|launch|start)|where .* start/.test(q)) intents.add("entry");
    if (/\b(break|impact|affect|depend(s|ent|encies)? on|modify|modifying|change|changing|refactor|remove|delete|rename|blast radius)\b/.test(q)) intents.add("impact");
    if (/relat|interact|between .+ and|connect|communicat|talk(s)? to|wire|wired|depend/.test(q)) intents.add("relationship");
    if (/which files?|where (is|are)|responsible|implemented|locate|find/.test(q)) intents.add("locate");

    const ent = this.resolveEntities(question);
    const ep = this.findEndpoint(question);
    if (ep) intents.add("endpoint");

    const sections = [];
    const focus = [];
    if (intents.has("architecture")) sections.push(...this.architectureFacts());
    if (intents.has("entry") || intents.has("architecture")) {
      const s = this.entryFacts();
      if (s) sections.push(s);
      for (const e of this.overview().entries.slice(0, 3)) focus.push({ file: e.file, line: e.line });
    }
    if (intents.has("locate") && !ep) {
      const s = this.locateFacts(question, ent);
      if (s) { sections.push(s.section); focus.push(...s.focus); }
    }
    if (ep) {
      const s = this.endpointFacts(ep);
      if (s) { sections.push(s.section); focus.push(...s.focus); }
    }
    if (ent.symbols.length || ent.files.length) {
      sections.push(this.definitionFacts(ent));
      for (const s of ent.symbols) focus.push({ file: s.file, line: s.line });
      if (intents.has("impact")) sections.push(...this.impactFacts(ent));
      if (intents.has("relationship") || intents.has("locate") || intents.has("impact")) {
        const r = this.relationshipFacts(ent);
        if (r) sections.push(r);
      }
    }
    return { sections: sections.filter((s) => s && s.lines.length), focus, intents: [...intents], entities: ent, endpoint: ep ? `${ep.method} ${ep.path}` : null };
  }

  architectureFacts() {
    const o = this.overview();
    const out = [];
    const proj = [];
    for (const p of o.packages) {
      const ln = p.lineOf("name") || 1;
      proj.push(`- \`${p.name || p.file}\`${p.description ? `: ${p.description}` : ""} ${cite(p.file, ln)}`);
    }
    if (o.readme) proj.push(`- README: “${o.readme.text}” ${cite(o.readme.file, o.readme.line)}`);
    if (o.frameworks.length) proj.push(`- Detected stack (from dependency manifests): ${o.frameworks.join(", ")}`);
    proj.push(`- ${this.files.length} source files analysed, ${[...this.imports.values()].reduce((s, x) => s + x.size, 0)} import relationships.`);
    out.push({ title: "Project", lines: proj });

    out.push({
      title: "Structure (largest folders)",
      lines: o.dirs.map((d) => `- \`${d.dir}/\` ${d.files} file${d.files === 1 ? "" : "s"}${d.role ? ` (looks like ${d.role}, by folder name)` : ""}`),
    });
    if (o.layerEdges.length) {
      out.push({
        title: "How folders depend on each other (import counts)",
        lines: o.layerEdges.map((e) => `- \`${e.from}\` → \`${e.to}\`: ${e.n} import${e.n === 1 ? "" : "s"}`),
      });
    }
    if (o.hubs.length) {
      out.push({
        title: "Most depended-on files",
        lines: o.hubs.filter((h) => h.fanIn > 1).map((h) => `- \`${h.file}\`: imported by ${h.fanIn} file${h.fanIn === 1 ? "" : "s"} ${cite(h.file, 1)}`),
      });
    }
    const idx = this.flow();
    if (idx?.endpoints?.length) {
      const groups = new Map();
      for (const e of idx.endpoints) {
        const segs = e.path.split("/").filter(Boolean);
        const g = "/" + segs.slice(0, segs[0] && /^(api|v\d+)$/.test(segs[0]) ? 2 : 1).join("/");
        groups.set(g, (groups.get(g) || 0) + 1);
      }
      out.push({
        title: `HTTP API (${idx.endpoints.length} endpoints)`,
        lines: [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g, n]) => `- \`${g}\`: ${n} route${n === 1 ? "" : "s"}`),
      });
    }
    return out;
  }

  entryFacts() {
    const o = this.overview();
    const lines = [];
    for (const p of o.packages) {
      for (const key of ["start", "dev", "serve"]) {
        if (p.scripts[key]) lines.push(`- \`npm run ${key}\` in \`${p.file}\` runs \`${p.scripts[key]}\` ${cite(p.file, p.lineOf(key))}`);
      }
      if (p.main) lines.push(`- \`${p.file}\` declares \`main: ${p.main}\` ${cite(p.file, p.lineOf("main"))}`);
    }
    for (const e of o.entries) {
      const where = /\.[A-Za-z0-9]+$/.test(e.file) && !/(^|\/)\.\w+$/.test(e.file) ? cite(e.file, e.line) : `(${e.file}, line ${e.line})`;
      lines.push(`- \`${e.file}\` ${e.why}: \`${e.text}\` ${where}`);
    }
    return lines.length ? { title: "Where the application starts", lines } : null;
  }

  definitionFacts(ent) {
    const lines = [];
    for (const s of ent.symbols) {
      const ls = this.lines(s.file) || [];
      lines.push(`- \`${s.name}\` (${s.kind}) is defined in \`${s.file}\`: \`${(ls[s.line - 1] || "").trim().slice(0, 120)}\` ${cite(s.file, s.line)}`);
    }
    for (const f of ent.files.filter((f) => !ent.symbols.some((s) => s.file === f)).slice(0, 4)) {
      const by = this.importedBy.get(f)?.size || 0;
      const im = this.imports.get(f)?.size || 0;
      lines.push(`- \`${f}\`: imports ${im} project file${im === 1 ? "" : "s"}, imported by ${by} ${cite(f, 1)}`);
    }
    return { title: "Definitions found", lines };
  }

  impactFacts(ent) {
    const out = [];
    for (const s of ent.symbols.slice(0, 2)) {
      const defs = this.symbols().get(s.name.toLowerCase()) || [];
      const refs = this.references(s.name, defs);
      const calls = refs.filter((r) => !r.import);
      const lines = calls.slice(0, 12).map((r) => `- \`${r.file}\`: \`${r.text}\` ${cite(r.file, r.line)}`);
      if (calls.length > 12) lines.push(`- …and ${calls.length - 12} more references`);
      out.push({
        title: `Code that references \`${s.name}\` (${calls.length} place${calls.length === 1 ? "" : "s"}, text search)`,
        lines: lines.length ? lines : [`- No references to \`${s.name}\` outside its definition were found in the indexed code.`],
      });
    }
    const files = [...new Set([...ent.symbols.map((s) => s.file), ...ent.files])].slice(0, 2);
    for (const f of files) {
      const levels = this.reverseDeps(f, 3);
      if (!levels.length) {
        out.push({ title: `Files that depend on \`${f}\``, lines: [`- No other project file imports \`${f}\`.`] });
        continue;
      }
      const lines = levels.map((lvl, i) => `- ${i === 0 ? "Directly imported by" : `${i + 1} hops away`}: ${lvl.slice(0, 10).map((x) => `\`${x}\``).join(", ")}${lvl.length > 10 ? ` (+${lvl.length - 10})` : ""}`);
      const tests = levels.flat().filter((x) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./.test(x));
      if (tests.length) lines.push(`- Tests in that set (run these after a change): ${tests.slice(0, 8).map((x) => `\`${x}\``).join(", ")}`);
      const eps = this.endpointsTouching(f);
      if (eps.length) lines.push(`- API endpoints whose traced flow passes through \`${f}\`: ${eps.slice(0, 10).map((e) => `\`${e}\``).join(", ")}${eps.length > 10 ? ` (+${eps.length - 10})` : ""}`);
      out.push({ title: `Files that depend on \`${f}\` (import graph)`, lines });
    }
    return out;
  }

  relationshipFacts(ent) {
    const files = [...new Set([...ent.symbols.map((s) => s.file), ...ent.files])];
    const lines = [];
    if (files.length >= 2) {
      for (let i = 0; i < Math.min(files.length, 3); i++) {
        for (let j = i + 1; j < Math.min(files.length, 3); j++) {
          const [a, b] = [files[i], files[j]];
          const ab = this.shortestImportPath(a, b);
          const ba = this.shortestImportPath(b, a);
          if (ab) lines.push(`- \`${a}\` reaches \`${b}\` through imports: ${ab.map((x) => `\`${x}\``).join(" → ")}`);
          if (ba) lines.push(`- \`${b}\` reaches \`${a}\` through imports: ${ba.map((x) => `\`${x}\``).join(" → ")}`);
          if (!ab && !ba) lines.push(`- No import path connects \`${a}\` and \`${b}\` in either direction.`);
        }
      }
      // calls from one file into functions the other file defines (AST-resolved for JS/TS)
      for (const [a, b] of [[files[0], files[1]], [files[1], files[0]]]) {
        for (const c of this.callSites(a, b)) {
          if (lines.length >= 30) break;
          lines.push(`- \`${a}\` calls \`${c.name}\` (defined in \`${b}\` ${cite(b, c.defLine)}): \`${c.text}\` ${cite(a, c.line)}`);
        }
      }
    } else if (files.length === 1) {
      const f = files[0];
      const im = [...(this.imports.get(f) || [])];
      const by = [...(this.importedBy.get(f) || [])];
      if (im.length) lines.push(`- \`${f}\` imports: ${im.slice(0, 12).map((x) => `\`${x}\``).join(", ")}${im.length > 12 ? ` (+${im.length - 12})` : ""}`);
      if (by.length) lines.push(`- \`${f}\` is imported by: ${by.slice(0, 12).map((x) => `\`${x}\``).join(", ")}${by.length > 12 ? ` (+${by.length - 12})` : ""}`);
      if (!im.length && !by.length) lines.push(`- \`${f}\` has no import relationships with other project files.`);
    }
    return lines.length ? { title: "Connections (import graph and call sites)", lines } : null;
  }

  /** Files that implement a feature named in plain words ("authentication", "payments"). */
  locateFacts(question, ent) {
    const words = (question.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w) && !/^(files?|which|where|implemented|locate|find|responsible)$/.test(w));
    if (!words.length) return null;
    const matches = (tok) => tok.length >= 3 && words.some((w) => w.startsWith(tok) || (tok.startsWith(w) && w.length >= 4));
    const scores = new Map();
    const bump = (f, n, why) => {
      if (!scores.has(f)) scores.set(f, { score: 0, why: new Set() });
      const e = scores.get(f);
      e.score += n;
      e.why.add(why);
    };
    for (const f of this.files) {
      const toks = f.toLowerCase().split(/[/._-]+/).filter(Boolean);
      if (toks.some(matches)) bump(f, 3, "file path");
    }
    for (const list of this.symbols().values()) {
      for (const d of list) {
        const parts = d.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_]+/);
        if (parts.some(matches)) bump(d.file, 1, `defines ${d.name}`);
      }
    }
    for (const f of ent.files) bump(f, 2, "named in the question");
    const isTest = (f) => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\./.test(f);
    const ranked = [...scores.entries()].filter(([f]) => !isTest(f) || /\btests?\b/.test(question.toLowerCase())).sort((a, b) => b[1].score - a[1].score).slice(0, 12);
    if (!ranked.length) return null;
    const lines = ranked.map(([f, e]) => {
      const role = (LAYER_HINTS.find(([re]) => re.test(f)) || [])[1];
      const defs = [...e.why].filter((w) => w.startsWith("defines ")).slice(0, 3).map((w) => `\`${w.slice(8)}\``);
      return `- \`${f}\`${role ? ` (${role})` : ""}${defs.length ? `: defines ${defs.join(", ")}` : ""} ${cite(f, 1)}`;
    });
    lines.push(`- _Matched by file names and symbol names containing: ${words.slice(0, 4).map((w) => `“${w}”`).join(", ")}._`);
    const focus = ranked.slice(0, 3).map(([f]) => {
      const d = [...this.symbols().values()].flat().find((x) => x.file === f);
      return { file: f, line: d?.line || 1 };
    });
    return { section: { title: "Files that implement this", lines }, focus };
  }

  endpointFacts(ep) {
    const idx = this.flow();
    if (!idx || !this.traceEndpoint) return null;
    let t;
    try {
      t = this.traceEndpoint(idx.project, ep, { maxDepth: 8, maxNodes: 120 });
    } catch {
      return null;
    }
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    const out = new Map();
    for (const e of t.edges) {
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from).push(e);
    }
    for (const l of out.values()) l.sort((a, b) => a.order - b.order);
    const lines = [`- Route registered in ${cite(ep.filePath, ep.startLine)}${ep.mountChain?.length ? `, mounted under ${ep.mountChain.map((m) => `\`${m.prefix}\` ${cite(m.file, m.line)}`).join(" then ")}` : ""}.`];
    if (ep.middleware?.length) lines.push(`- Middleware, in order: ${ep.middleware.map((m) => `\`${m}\``).join(" → ")}`);
    const verbs = { calls: "calls", queries: "database:", external: "external call:", responds: "responds", error: "error path:" };
    const seen = new Set();
    const walk = (id, depth) => {
      for (const e of out.get(id) || []) {
        if (lines.length > 40 || e.to === id) continue;
        const to = byId.get(e.to);
        if (!to) continue;
        if (e.kind === "next" || e.kind === "handles") {
          if (to.kind === "handler") lines.push(`- Handler \`${to.name}\` ${cite(to.filePath, to.line, to.endLine)}`);
          if (!seen.has(e.to)) { seen.add(e.to); walk(e.to, e.kind === "handles" ? 1 : depth); }
          continue;
        }
        const where = e.file && e.lines.length ? cite(e.file, e.lines[0]) : "";
        const label = e.kind === "responds" ? `${verbs.responds} ${to.status}${to.sender ? ` via ${to.sender}()` : ""}` : `${verbs[e.kind] || e.kind} \`${to.name}\``;
        lines.push(`${"  ".repeat(Math.min(depth, 4))}- ${label}${e.conditional ? " (only on some paths)" : ""} ${where}`);
        if (!seen.has(e.to)) { seen.add(e.to); walk(e.to, depth + 1); }
      }
    };
    walk(t.entryId, 1);
    for (const n of (t.notes || []).filter((x) => x.severity === "warn")) lines.push(`- Analysis note: ${n.title}. ${n.detail}`);
    const focus = t.nodes.filter((n) => n.kind === "handler" || n.kind === "service" || n.kind === "controller").slice(0, 6).map((n) => ({ file: n.filePath, line: n.line }));
    return { section: { title: `Traced flow of ${ep.method} ${ep.path} (static analysis)`, lines }, focus };
  }

  // ---------------------------------------------------------------- graph utils

  reverseDeps(file, maxDepth = 3) {
    const levels = [];
    const seen = new Set([file]);
    let frontier = [file];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next = [];
      for (const f of frontier) for (const p of this.importedBy.get(f) || []) if (!seen.has(p)) { seen.add(p); next.push(p); }
      if (next.length) levels.push(next.sort());
      frontier = next;
    }
    return levels;
  }

  /** Calls in `from` that resolve to functions defined in `to`. */
  callSites(from, to) {
    const idx = this.flow();
    if (idx?.project && this.callSitesInto && /\.(m?js|cjs|jsx|tsx?)$/.test(from)) {
      try {
        return this.callSitesInto(idx.project, from, to);
      } catch {
        return [];
      }
    }
    if (from.endsWith(".py")) return this.pyCallSites(from, to);
    return [];
  }

  /** Python: calls through names imported from `to` (`from x import f` / `import x as m; m.f()`). */
  pyCallSites(from, to) {
    const ls = this.lines(from) || [];
    const toMod = to.replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
    const names = new Set();
    const aliases = new Set();
    for (const l of ls) {
      let m = l.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
      if (m && (toMod.endsWith(m[1].replace(/^\.+/, "")) && m[1].replace(/^\.+/, ""))) {
        for (const part of m[2].replace(/[()\\]/g, "").split(",")) {
          const [orig, alias] = part.trim().split(/\s+as\s+/);
          if (orig) names.add((alias || orig).trim());
        }
      }
      m = l.match(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
      if (m && toMod.endsWith(m[1])) aliases.add(m[2] || m[1]);
    }
    const defs = new Map();
    for (const list of this.symbols().values()) for (const d of list) if (d.file === to) defs.set(d.name, d);
    const out = [];
    ls.forEach((l, i) => {
      if (/^\s*(#|from\s|import\s|def\s|class\s)/.test(l)) return;
      for (const n of names) if (defs.has(n) && new RegExp(`(^|[^\\w.])${n}\\s*\\(`).test(l)) out.push({ line: i + 1, name: n, defLine: defs.get(n).line, text: l.trim().slice(0, 140) });
      for (const a of aliases) for (const m of l.matchAll(new RegExp(`(?:^|[^\\w.])${a.replace(/\./g, "\\.")}\\.(\\w+)\\s*\\(`, "g"))) if (defs.has(m[1])) out.push({ line: i + 1, name: m[1], defLine: defs.get(m[1]).line, text: l.trim().slice(0, 140) });
    });
    return out.slice(0, 30);
  }

  shortestImportPath(from, to, maxDepth = 6) {
    const prev = new Map([[from, null]]);
    let frontier = [from];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next = [];
      for (const f of frontier) {
        for (const t of this.imports.get(f) || []) {
          if (prev.has(t)) continue;
          prev.set(t, f);
          if (t === to) {
            const p = [to];
            let c = f;
            while (c) { p.unshift(c); c = prev.get(c); }
            return p;
          }
          next.push(t);
        }
      }
      frontier = next;
    }
    return null;
  }

  endpointsTouching(file) {
    const idx = this.flow();
    if (!idx || !this.traceEndpoint) return [];
    if (!this._epFiles) {
      this._epFiles = new Map();
      for (const ep of idx.endpoints.slice(0, 400)) {
        try {
          const t = this.traceEndpoint(idx.project, ep, { maxDepth: 6, maxNodes: 80 });
          const key = `${ep.method} ${ep.path}`;
          for (const n of t.nodes) {
            if (!n.filePath) continue;
            if (!this._epFiles.has(n.filePath)) this._epFiles.set(n.filePath, new Set());
            this._epFiles.get(n.filePath).add(key);
          }
        } catch {
          // a single failing trace must not break the answer
        }
      }
    }
    return [...(this._epFiles.get(file) || [])];
  }
}

/** Render fact sections as Markdown (used in the offline answer and the LLM context). */
export function renderFacts(sections) {
  return sections.map((s) => `**${s.title}**\n${s.lines.join("\n")}`).join("\n\n");
}
