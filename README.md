![Developer Banner](https://ishan-rest.vercel.app/svg/banner/dev5/CodeAtlas)

# CodeAtlas

## Turn any GitHub repository into an interactive dependency graph

CodeAtlas is a full-stack developer tool that transforms GitHub repositories into **interactive dependency graphs**, enabling visual exploration of code structure, module relationships, and architectural flow.

It helps developers understand unfamiliar codebases faster by turning static files into an explorable system map.

---

## Preview

<img width="1512" height="861" alt="Screenshot 2026-04-21 at 20 29 31" src="https://github.com/user-attachments/assets/8309c60d-53a4-49c2-8f0a-b1a107040ca5" />


---

## Key Features

### Dependency Graph Visualisation
- Interactive force-directed graph powered by D3.js
- Visual representation of file-level dependencies
- Real-time node interaction and navigation

### AST-Based Code Analysis
- Parses source code using Abstract Syntax Trees (AST)
- Extracts import relationships across modules
- Language-aware parsing system

### Code Exploration
- Clickable nodes to inspect file contents
- Monaco Editor integration for syntax-highlighted preview
- Import + dependency side panel

### Navigation Tools
- Focus mode (local subgraph exploration)
- Depth control for traversal limiting
- Search support for files and nodes

---

## New in this release

### API Flow Tracing
Click **API Flow** after analyzing a repository to see every HTTP route and trace a request through the code:
**route → middleware → handler → controllers / services → database / external APIs → response**.

- **AST-based and evidence-backed.** Routes, mounts and calls are resolved with Babel scope analysis across files (ESM, CommonJS, re-exports, `module.exports` objects, classes, `new Service()` instances, `this.method()`). Every arrow corresponds to a line of code, and each edge carries its call-site line numbers. Calls that can't be resolved statically (callbacks, parameters, dynamic dispatch) are listed as *unresolved* on the node instead of being guessed.
- **Express:** `app/router.METHOD`, `router.route().get().post()`, `app.use(prefix, …middleware, router)` mounting across files (including `routes.forEach(r => router.use(r.path, r.route))` over a literal array), path-scoped middleware, wrappers such as `asyncHandler(fn)` / `catchAsync(fn)`, status codes (`res.status(404)`, `httpStatus.CREATED`), `next(err)` and `throw new ApiError(…)`, Mongoose / Prisma / Sequelize / SQL clients, axios / fetch, JWT and other SDKs.
- **Flask / FastAPI:** `@bp.route`, `@router.get`, Blueprint / APIRouter prefixes including `register_blueprint(bp, url_prefix=…)` from another module, `from x import y` calls, class and mixin methods, SQLAlchemy sessions, `abort()`, `jsonify` / `redirect` / `render_template` / tuple status responses.
- **Interactive graph:** layered left-to-right layout with crossing reduction, zoom / pan / fit, minimap, hover to highlight a node's whole path, collapsible subtrees, show/hide filters per step kind (hidden steps are bypassed so the chain stays connected), long global middleware chains grouped into one expandable node, and a depth control.
- **Steps view** lists the request's journey in execution order. The **details panel** shows location, parameters, callers and callees, conditional calls, unresolved calls and library calls. **Open source** jumps to the exact lines in the code viewer.
- **Keyboard:** arrows walk the graph, `Enter` opens the source, `Space` collapses or expands, `F` fits, `+` / `-` zoom, `Esc` deselects.

#### Understanding a flow
- **Explain this API**: the right panel's first tab summarises the endpoint: purpose (doc comment when present, otherwise HTTP convention, clearly labelled), what the code does (reads / writes / external calls / status codes), the middleware it passes through, a nested "what happens inside" list, possible outcomes (conditional vs. not), and the data and external systems involved.
- **Node explanations**: selecting a node shows *what it does*, *why it's in this flow* (who calls it, and where), and *where in the code*, with the exact lines highlighted inline. Doc comments / docstrings are quoted from the source. Each node shows its resolution: Resolved, Pattern match or Unresolved.
- **Why is this connected?**: click any arrow (or "Why?" next to a connection) to see the connecting line, the import that binds the callee (specifier and line), and the target's definition, each with a source preview.
- **Walkthrough**: the Steps view is a timeline grouped by stage (request → middleware → handler → logic → data → external → response / errors). **Walk through** steps through the graph in execution order (play / pause, ← / →, Esc).
- **Analysis notes**: plain-language explanations of what the static analysis couldn't determine (unmounted router, unresolved handler, calls decided at runtime, depth / size limits, third-party middleware, runtime status codes, pattern-based detections), with what to do and links to the affected nodes.
- Explanations are built from the analyzer's recorded evidence only. Statements that are hints (e.g. "its name suggests authentication") are tagged *inferred from name* or *convention*, and every trace is marked **Static · not a runtime trace**.

Endpoints: `GET /endpoints`, then `GET /flow?id=<endpoint id>&depth=1-12` (or `?method=GET&path=/api/users`). The response is a graph `{ nodes, edges, stats, warnings, partial }`.

### Live Impact Simulator ("What-if" analysis)
Right-click any file in the graph (or use **Simulate Change Impact** in the File Inspector) to run a reverse-transitive closure over the import graph. The canvas dims everything else and reveals affected files hop by hop, and a summary card shows the blast radius, for example *"4 APIs and 12 test files could break"*, with a 0-100 risk score and the exact regression test scope to run.

### Ask AI (Ctrl/Cmd + J)
Ask questions about the analyzed repository in plain English. Every answer is grounded in the repository and cites `[path/file.ts:L10-L42]`; each citation opens the code viewer with those lines highlighted.

How a question is answered (`POST /ask`, streamed over SSE):
1. **Structural analysis** (`backend/rag/codeKnowledge.js`). CodeLens recognises what the question is about and answers that part from its own analysis, not from text search:
   - *architecture*: dependency manifests and stack, folder layers and how they import each other, most depended-on files, API groups;
   - *entry points*: `start`/`dev` scripts, `main`, `.listen(…)`, `app.run(…)`, `createRoot(…)`;
   - *an endpoint* (`GET /api/users/:id`): the full traced API flow (middleware, handler, services, database, responses);
   - *impact* ("what breaks if I change X"): real call sites of the symbol, files that import it (up to 3 hops), the tests among them, and the endpoints whose flow passes through it;
   - *relationships* ("between A and B"): import paths in both directions and the actual calls from one to the other, resolved with the same AST resolver API Flow uses;
   - *location* ("which files handle authentication"): files and symbols matching the feature.
2. **Code retrieval**: symbol-aware chunks with exact line ranges in a local hybrid index (hashed dense embeddings + BM25), re-ranked for code (definitions named in the question first, boilerplate docs and tests last unless asked), then expanded one hop along the import graph.
3. **Answer**: with `ANTHROPIC_API_KEY` set, Claude (`claude-opus-5-5`, adaptive thinking) writes the answer from the analysis facts and the excerpts only, cites every claim and marks anything beyond the evidence as *(inferred)*. Without a key, or if the AI service fails, the answer is assembled directly from the analysis facts and the most relevant code, labelled **static analysis only**; nothing is invented either way.
4. **Follow-ups**: the last turns of the conversation are sent with each question, so "and what calls it?" works.

The chat shows which analyses backed each answer (e.g. *API flow trace*, *impact analysis*) and whether it was written by the AI or assembled from static analysis.

### Command palette (Ctrl/Cmd + K)
Fuzzy-jump to any file or run any action (simulate impact for the selected file, ask AI, open diagnostics or API flow, switch views, export PNG or PDF) from the keyboard. Arrow keys to move, Enter to run, Esc to close.

### "Start here" guided tour
Ranks files with PageRank over the production import graph (tests, examples and docs are ignored when scoring) and suggests the handful a newcomer should read first, in order: entry points, API surface, hubs, then shared core modules. **Start guided tour** steps through them, opening each in the code viewer.

### Cinematic landing
A once-per-session lens preloader (skippable, honours reduced-motion), word-mask headline reveal, scroll progress bar, magnetic CTA, 3D-tilt feature cards and a page-wipe transition into the analyzer. Everything animates opacity/transform only.

### Executive PDF audit report
**Export Audit Report** builds a multi-page A4 report: cover with health score and grade, KPI cards, executive summary with recommended actions, high-resolution graph and sunburst snapshots, circular dependency, god module and dead code tables, hotspots, the current impact simulation, and the discovered API surface.

### Circular Sunburst view
Toggle **Node Graph / Circular Sunburst**. Core modules that import nothing internal sit in the centre; each ring outward depends only on the rings inside it, so entry points and peripheral code sit on the outside (cycles are collapsed with Tarjan SCC so layering is always defined).

### Performance
Both graph views render on a single `<canvas>` with batched paths and only draw frames while something moves, so large repositories stay at the display refresh rate. Routes are code-split, and Monaco, jsPDF and html2canvas load only when needed.

## Running locally

Requirements: **Node.js 20.12+** (22 recommended) and **git** on the PATH (used to clone repositories). No database is required.

```bash
# backend (terminal 1)
cd backend
cp .env.example .env        # optional: add ANTHROPIC_API_KEY for AI-written answers
npm install
npm start                   # http://localhost:8080
npm test                    # 55 tests

# frontend (terminal 2)
cd frontend
cp .env.example .env        # optional: Supabase keys for login; the analyzer works without them
npm install
npm run dev                 # http://localhost:5173 (talks to http://localhost:8080)
```

Open http://localhost:5173/analyze and paste a public GitHub URL.

## Configuration

**Backend** (`backend/.env`, all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `ANTHROPIC_API_KEY` | – | Enables AI-written answers in Ask AI. Without it Ask AI answers from static analysis. |
| `CODELENS_MODEL` | `claude-opus-5-5` | Claude model for Ask AI |
| `CODELENS_TMP_DIR` | `./tmp` | Writable directory where the analyzed repository is cloned (replaced on every analysis) |
| `CORS_ORIGINS` | any origin | Comma-separated allow-list of frontend origins. **Set in production** when the frontend is on another domain. |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy / load balancer so rate limits use the client IP |
| `SERVE_FRONTEND` | off | `true` serves `../frontend/dist` from the backend (single-server deployment), or give a path |
| `CODELENS_MAX_FILES` / `CODELENS_MAX_CHUNKS` | `8000` / `40000` | Limits for very large repositories |

**Frontend** (`frontend/.env`, read at **build** time):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | dev: `http://localhost:8080`, prod: same origin | Backend URL when it runs on a different origin |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | – | Optional login / dashboard (public anon key only). Without them the analyzer still works and login is disabled. |

## Deployment

There is no database or migration step: analysis state lives in memory and in `CODELENS_TMP_DIR`.

**Option A: one server (simplest).** The backend serves the built frontend.
```bash
cd frontend && npm ci && npm run build          # writes frontend/dist
cd ../backend && npm ci --omit=dev
SERVE_FRONTEND=true NODE_ENV=production PORT=8080 node server.js
```

**Option B: Docker (same layout, one container).**
```bash
docker build -t codelens .
docker run -p 8080:8080 -e ANTHROPIC_API_KEY=sk-... codelens
# optional login: docker build --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=... -t codelens .
```
The image runs as a non-root user, includes git, and has a `HEALTHCHECK` on `/health`.

**Option C: separate frontend and API.** Deploy `backend/` (or `docker build ./backend`) to any Node host, and the static `frontend/dist` (built with `VITE_API_URL=https://your-api`) to any static host (Netlify, Vercel, S3/CloudFront, nginx). Set `CORS_ORIGINS=https://your-frontend` on the backend and configure the static host to rewrite unknown paths to `index.html` (client-side routes). Behind a proxy, also set `TRUST_PROXY=1`.

Platform notes: the backend needs a writable disk for `CODELENS_TMP_DIR` and outbound HTTPS to github.com (and to api.anthropic.com for AI answers). `GET /health` returns `{ ok, repo, ai }` for health checks.

**Operational limits.** The server analyzes **one repository at a time** and keeps it in memory: a new analysis replaces the previous one for every user of that server, and concurrent analyses are rejected with HTTP 409. Run one instance per team (or per user) rather than one shared public instance. `/analyze` is rate limited to 10 requests per 15 minutes per IP and `/ask` to 20 per minute. The backend has no user accounts of its own: Supabase login protects the dashboard page only, so put the API behind your own auth or network controls if it must not be public.

## Supported Languages

Current support:
- JavaScript / TypeScript: dependency graph, AST-based API flow tracing (Express), Ask AI
- Python: dependency graph, API flow tracing (Flask / FastAPI, line-based analysis), Ask AI

Planned:
- Go
- Java
- C++
- Rust

---

## Architecture Overview
GitHub Repo URL
 →
Backend (Node.js + Express)
 →
Repository Cloning (simple-git)
 →
Indexing + AST analysis (@babel/parser for JS/TS, line-based Python analysis)
 →
Dependency Graph Builder
 →
JSON Graph API
 →
Analyses: diagnostics, API flow tracing, impact, Ask AI (retrieval + structural facts + Claude)
 →
Frontend Visualisation (React + D3.js + Monaco)

---

## How It Works

1. User submits a GitHub repository URL
2. Backend clones the repository locally (shallow clone for performance)
3. Source files are scanned and parsed using AST parsers
4. Import statements are extracted and converted into graph edges
5. Nodes and relationships are structured into a graph model
6. Frontend renders the graph using D3.js force simulation

---

## Tech Stack

### Frontend
- React + TypeScript
- D3.js (graph rendering engine)
- Monaco Editor (code viewer)
- Tailwind CSS, lucide-react, jsPDF + html2canvas (audit report), Supabase (optional login)

### Backend
- Node.js + Express
- simple-git (repo cloning)
- @babel/parser (AST parsing)
- fs-extra (file system utilities)
- @anthropic-ai/sdk (Ask AI answers, optional)
- express-rate-limit, cors

---

## Design Goals

CodeAtlas was built to solve a core developer problem:

> Understanding large codebases is harder than writing them.

Instead of manually tracing imports or navigating folders, CodeAtlas allows developers to:
- Visually explore architecture
- Identify dependency chains quickly
- Understand system structure at a glance

---

## Performance Notes

- Shallow cloning reduces repository load time
- File filtering excludes heavy directories (`node_modules`, `dist`, etc.)
- Import parsing is limited for performance safety
- Graph rendering optimised for medium-scale repositories

---

## Future Improvements

### Core Enhancements
- Folder-level and module-level graph abstraction
- Function and class-level dependency mapping
- Smarter cross-language resolution engine

### Scaling Improvements
- Streaming graph rendering for large repos
- Incremental parsing instead of full repo reload
- Caching layer for repeated repository analysis

### Language Expansion
- Go AST pipeline
- Java class dependency mapping
- C++ include graph parsing

---

## 🤝 Contributions

Contributions are welcome and appreciated.

If you want to improve CodeAtlas:
- Fork the repository
- Create a feature branch
- Submit a pull request

---

## ⭐ Support

If you find CodeAtlas useful:
- Star the repository
- Share it with developers
- Try it on real-world codebases
- Reporting issues or suggesting improvements

---

## 📌 Status

Early-stage but actively developed system focused on real-world repository understanding and developer tooling.
---

## 🤝 Sponsors

CodeAtlas is built and maintained in public.

As the project grows, infrastructure costs (repo processing, graph computation, hosting, and API usage) increase significantly. Sponsors help keep the core platform free and accessible while supporting continued development.

### 💡 Why sponsor?

Supporting CodeAtlas helps fund:
- Backend compute for repository analysis
- Hosting and scaling infrastructure
- Development of new language parsers (Go, Java, C++)
- New features like module-level graphs and AI-assisted code understanding

---

> Every bit of support helps keep CodeAtlas growing.

