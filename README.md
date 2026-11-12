![Developer Banner](https://ishan-rest.vercel.app/svg/banner/dev5/CodeLens)

# CodeLens

## Turn any GitHub repository into an interactive dependency graph

CodeLens is a full-stack developer tool that transforms GitHub repositories into **interactive dependency graphs**, enabling visual exploration of code structure, module relationships, and architectural flow.

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

### Import Analysis
- Extracts import relationships across modules and resolves them to repository files
- JavaScript / TypeScript (`import`, `require`, dynamic `import()`, `index` files) and Python (`import x.y`, `from .pkg import mod`, relative imports, `src/` layouts)
- Circular dependency, god-module and dead-code diagnostics with a 0-100 health score

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

### Live Impact Simulator ("What-if" analysis)
Right-click any file in the graph (or use **Simulate Change Impact** in the File Inspector) to run a reverse-transitive closure over the import graph. The canvas dims everything else and reveals affected files hop by hop, and a summary card shows the blast radius, for example *"4 APIs and 12 test files could break"*, with a 0-100 risk score and the exact regression test scope to run.

### RAG codebase Q&A ("Ask AI", Ctrl/Cmd + K)
`POST /ask` with `{ "question": "..." }` answers questions about the analysed repository:
1. **Vector search**: every file is split into symbol-aware chunks with exact line ranges and indexed in a local hybrid store (hashed dense embeddings + BM25). No external vector DB needed; the store has the same add/search surface as a pgvector or Chroma adapter.
2. **Graph expansion**: retrieved chunks are expanded one hop along the dependency graph (importers and imports) to pull in callers and callees.
3. **Grounded answer**: Claude (`claude-opus-5-5`) answers only from those excerpts and cites every claim as `[path/file.ts:L10-L42]`. If the answer is not in the context it says so instead of guessing.

Answers stream into a chat drawer; each citation is a badge that opens the file in the code viewer with those lines highlighted. Without `ANTHROPIC_API_KEY` the endpoint runs in offline mode and returns the most relevant cited code locations.

### Executive PDF audit report
**Export Audit Report** builds a multi-page A4 report: cover with health score and grade, KPI cards, executive summary with recommended actions, high-resolution graph and sunburst snapshots, circular dependency, god module and dead code tables, hotspots, the current impact simulation, and the discovered API surface.

### Circular Sunburst view
Toggle **Node Graph / Circular Sunburst**. Core modules that import nothing internal sit in the centre; each ring outward depends only on the rings inside it, so entry points and peripheral code sit on the outside (cycles are collapsed with Tarjan SCC so layering is always defined).

### Performance
Both graph views render on a single `<canvas>` with batched paths and only draw frames while something moves, so large repositories stay at the display refresh rate. Routes are code-split, and Monaco, jsPDF and html2canvas load only when needed.

## Running locally

```bash
# backend
cd backend
cp .env.example .env        # add ANTHROPIC_API_KEY for AI answers (optional)
npm install
npm start                   # http://localhost:8080 (keep this terminal open)
npm test

# frontend
cd frontend
cp .env.example .env        # Supabase keys for login (optional; the analyzer works without them)
npm install
npm run dev                 # http://localhost:5173
```

## Supported Languages

Current support:
- JavaScript
- TypeScript
- Python

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
AST Parsing Layer (@babel/parser, Python AST)
 →
Dependency Graph Builder
 →
JSON Graph API
 →
Frontend Visualisation (React + D3.js)

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

### Backend
- Node.js + Express
- simple-git (repo cloning)
- @babel/parser (AST parsing)
- fs-extra (file system utilities)

---

## Design Goals

CodeLens was built to solve a core developer problem:

> Understanding large codebases is harder than writing them.

Instead of manually tracing imports or navigating folders, CodeLens allows developers to:
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

If you want to improve CodeLens:
- Fork the repository
- Create a feature branch
- Submit a pull request

---

## ⭐ Support

If you find CodeLens useful:
- Star the repository
- Share it with developers
- Try it on real-world codebases
- Reporting issues or suggesting improvements

---

## 📌 Status

Early-stage but actively developed system focused on real-world repository understanding and developer tooling.
---

## 🤝 Sponsors

CodeLens is built and maintained in public.

As the project grows, infrastructure costs (repo processing, graph computation, hosting, and API usage) increase significantly. Sponsors help keep the core platform free and accessible while supporting continued development.

### 💡 Why sponsor?

Supporting CodeLens helps fund:
- Backend compute for repository analysis
- Hosting and scaling infrastructure
- Development of new language parsers (Go, Java, C++)
- New features like module-level graphs and AI-assisted code understanding

---

> Every bit of support helps keep CodeLens growing.



---

## Notes

- The analyzer talks to `http://localhost:8080` by default. To point the UI at a deployed backend, set `VITE_API_URL` in `frontend/.env`.
- Only public GitHub repositories are supported. `/analyze` is rate limited (30 per 15 minutes per IP by default, `ANALYZE_RATE_LIMIT_MAX`).
- Supabase keys are only needed for login / dashboard. `/analyze`, `/docs` and the landing page work without them.
- Without `ANTHROPIC_API_KEY`, "Ask AI" runs in offline mode and returns the most relevant code locations instead of a written answer.

## Deploy on Render (single service)

The root `Dockerfile` builds the frontend and runs the API, which also serves the UI, so everything lives on one URL.

1. Push the repo to GitHub, then Render → New → Web Service → pick the repo.
2. Language: **Docker** (root `Dockerfile`), instance type: Free.
3. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (optional), `ANTHROPIC_API_KEY` (optional).
4. Deploy, then open the `.onrender.com` URL. `/health` should return `{"ok":true}`.
