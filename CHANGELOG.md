# 📜 Changelog

All notable changes to **CodeAtlas** will be documented in this file.

---

## [2.0.0] - 2026-11-14

### 🚀 Added
- **API Flow Tracing**: AST-based route discovery and request tracing (Express, Flask, FastAPI) with an interactive graph, step-by-step walkthrough, node and connection explanations, inline source previews and plain-language analysis notes.
- **Ask AI understands the repository's structure**: architecture, entry points, traced endpoint flows, change impact, component relationships and feature location are answered from CodeLens's own analysis with `file:line` citations; Claude writes the answer when `ANTHROPIC_API_KEY` is set, otherwise the answer is assembled from static analysis. Follow-up questions use conversation history.
- Single-server mode (`SERVE_FRONTEND`), root multi-stage `Dockerfile`, `.dockerignore`, health check reporting repo / AI status.
- Configuration: `CORS_ORIGINS`, `TRUST_PROXY`, `CODELENS_MAX_FILES`, `CODELENS_MAX_CHUNKS`.

### 🛠️ Changed
- Production frontend builds call the same origin unless `VITE_API_URL` is set (no hardcoded backend URL).
- Upgraded `simple-git` to 4.x and `monaco-editor` to 0.57; patched `qs` and `dompurify` through overrides. Production dependencies report 0 known vulnerabilities.
- CI runs on Node 22 with lint and production dependency audits.

### 🐛 Fixed
- git subprocesses no longer receive the server's environment (API keys and other secrets).
- Starting a new analysis (or a failed one) no longer leaves endpoints, flows or Ask AI answering about the previous repository.
- Ask AI: relationship answers no longer match unrelated functions by name; entry-point detection no longer reports non-server `.listen()` calls or test scripts.
- Login / signup explain when Supabase is not configured instead of redirecting to a placeholder project.
- Internal error messages are no longer returned in API responses; unknown API routes return JSON 404s.

### 🧹 Removed
- Unused code (`parser.js`, `parser_py.py`), a stray cloned repository in `backend/tmp`, install logs, unused dependencies (`three`, `@babel/*` and `simple-git` in the frontend, `babel-jest`, `@babel/preset-env`) and an unused Tailwind v3 config.

---

## [Unreleased]

### 🚀 Added
- Copy file path button in File Inspector
- Improved dependency resolution for local imports
- Backlinks tracking (files that depend on a file)
- Rate limiting on `/analyze` endpoint

### 🛠️ Changed
- Improved graph formatting and normalization
- Refactored frontend API handling for flexibility
- Better handling of invalid graph responses

### 🐛 Fixed
- D3 crash (`node not found`) when imports point to non-existent nodes
- Backend returning HTML instead of JSON on errors
- Duplicate links in graph output

### 🧪 Testing
- Added Jest setup for parser
- Added initial parser unit tests
- Ignored `/tmp` folder during tests

---

## [0.1.0] - Initial Release

### 🚀 Added
- GitHub repo analysis via URL
- Automatic repo cloning using `simple-git`
- AST-based import extraction (JS, TS, JSX, TSX)
- Dependency graph generation (nodes + links)
- Interactive graph visualization (D3.js)
- File inspector panel
- Monaco editor integration for file preview

### 🧠 Core Features
- Graph-based codebase exploration
- Import relationship mapping
- Focus mode (depth-based filtering)
- Multi-language support (JavaScript, TypeScript, Python)

---

## 🔮 Upcoming

- Folder → File → Module hierarchy view
- Support for Go language
- Function-level dependency analysis
- Graph performance optimizations (large repos)
- GitHub API integration (no local cloning)
- Export/share graphs
- Circular Dependency detection and dynamic imports
- Private repo support and local file analysis

---

## 📌 Notes

- Early-stage project: rapid iteration expected
- Breaking changes may occur before v1.0.0
