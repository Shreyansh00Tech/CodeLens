import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowRight, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Code2, GitBranch, ListTree, Play,
  Maximize2, Minus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Search, Workflow, X,
} from "lucide-react";
import type { Endpoint, FlowEdge, FlowNode, FlowTrace } from "../lib/types";
import { groupMiddleware, kindGroup, layoutFlow, relatedIds } from "../lib/flowLayout";
import { buildWalkthrough, explainEdge, explainEndpoint, explainNode, indexGraph, type Graph } from "../lib/flowExplain";
import { CodePreview, EvidenceList, NotesPanel, SentenceList, WalkthroughBar, WalkthroughView, type FileLoader, type OpenRange } from "./apiflow/Explain";
import FlowCanvas, { type FlowCanvasHandle } from "./apiflow/FlowCanvas";
import { EDGE_VERB, KIND_META, LEGEND_GROUPS, METHOD_COLORS, nodeColor, shortFile, statusColor } from "./apiflow/flowTheme";

type Props = {
  apiBase: string;
  repoUrl: string;
  onInspectFile: (filePath: string, range?: { start: number; end: number } | null) => void;
};

type LoadState<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null; error: string | null };

const MONO = "font-mono";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export default function ApiFlowPanel({ apiBase, repoUrl, onInspectFile }: Props) {
  // ---------------------------------------------------------------- endpoints
  const [eps, setEps] = useState<LoadState<{ endpoints: Endpoint[]; note: string | null }>>({ status: "idle", data: null, error: null });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!repoUrl) return;
    const ctrl = new AbortController();
    setEps({ status: "loading", data: null, error: null });
    fetch(`${apiBase}/endpoints`, { signal: ctrl.signal })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
        setEps({ status: "ready", data: { endpoints: data.endpoints || [], note: data.note || null }, error: null });
      })
      .catch((e: Error) => { if (e.name !== "AbortError") setEps({ status: "error", data: null, error: e.message || "Could not load endpoints." }); });
    return () => ctrl.abort();
  }, [apiBase, repoUrl, reloadKey]);
  const endpoints = useMemo(() => eps.data?.endpoints ?? [], [eps.data]);

  const [query, setQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return endpoints.filter((ep) =>
      (!methodFilter.size || methodFilter.has(ep.method)) &&
      (!q || ep.path.toLowerCase().includes(q) || (ep.handler || "").toLowerCase().includes(q) || ep.filePath.toLowerCase().includes(q) || ep.method.toLowerCase() === q),
    );
  }, [endpoints, query, methodFilter]);

  const groups = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    for (const ep of filtered) {
      const segs = ep.path.split("/").filter(Boolean);
      const key = segs.length === 0 ? "/" : segs[0] === "api" && segs[1] && !segs[1].startsWith(":") ? `/api/${segs[1].replace(/^v\d+$/, (v) => (segs[2] ? `${v}/${segs[2]}` : v))}` : `/${segs[0]}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(ep);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const methodCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ep of endpoints) c[ep.method] = (c[ep.method] || 0) + 1;
    return c;
  }, [endpoints]);

  // ---------------------------------------------------------------- trace
  const [selectedEp, setSelectedEp] = useState<Endpoint | null>(null);
  const [trace, setTrace] = useState<LoadState<FlowTrace>>({ status: "idle", data: null, error: null });
  const [depth, setDepth] = useState(8);
  const traceCtrl = useRef<AbortController | null>(null);

  const runTrace = useCallback(async (ep: Endpoint, d: number) => {
    traceCtrl.current?.abort();
    const ctrl = new AbortController();
    traceCtrl.current = ctrl;
    setTrace((t) => ({ status: "loading", data: t.data, error: null }));
    const params = new URLSearchParams({ depth: String(d) });
    if (ep.id) params.set("id", ep.id);
    else { params.set("method", ep.method); params.set("path", ep.path); }
    try {
      const r = await fetch(`${apiBase}/flow?${params}`, { signal: ctrl.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Trace failed (${r.status})`);
      if (!Array.isArray(data.nodes)) throw new Error("The server returned an unexpected trace format.");
      setTrace({ status: "ready", data: data as FlowTrace, error: null });
    } catch (e) {
      const err = e as Error;
      if (err.name !== "AbortError") setTrace({ status: "error", data: null, error: err.message || "Trace request failed." });
    }
  }, [apiBase]);
  useEffect(() => () => traceCtrl.current?.abort(), []);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"graph" | "steps">("graph");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [walkIndex, setWalkIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<FlowCanvasHandle | null>(null);

  // Source files for inline previews: fetched once per analysis (this panel is re-keyed per analysis).
  const fileCache = useRef(new Map<string, Promise<string[]>>());
  const loadFile = useCallback<FileLoader>((path) => {
    const hit = fileCache.current.get(path);
    if (hit) return hit;
    const p = fetch(`${apiBase}/file?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return String(d.content ?? "").split("\n");
      });
    p.catch(() => fileCache.current.delete(path)); // allow retry after a failure
    fileCache.current.set(path, p);
    return p;
  }, [apiBase]);
  const openRange = useCallback<OpenRange>((file, start, end) => onInspectFile(file, { start, end: Math.max(start, end) }), [onInspectFile]);

  const selectEndpoint = useCallback((ep: Endpoint) => {
    setSelectedEp(ep);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setWalkIndex(null);
    setPlaying(false);
    setHoverId(null);
    setCollapsed(new Set());
    setExpandedGroups(new Set());
    runTrace(ep, depth);
  }, [runTrace, depth]);

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const data = trace.data;
  const graph = useMemo(() => (data ? groupMiddleware(data.nodes, data.edges, data.entryId, expandedGroups) : null), [data, expandedGroups]);
  const layout = useMemo(() => (data && graph && graph.nodes.length ? layoutFlow(graph.nodes, graph.edges, data.entryId, { collapsed, hiddenKinds }) : null), [data, graph, collapsed, hiddenKinds]);
  const nodeById = useMemo(() => new Map((graph?.nodes || []).concat(data?.nodes || []).map((n) => [n.id, n])), [graph, data]);
  const visibleEdges = layout?.edges;
  const focusCandidate = hoverId || selectedNodeId;
  const focusId = focusCandidate && layout?.byId.has(focusCandidate) ? focusCandidate : null;
  const highlight = useMemo(() => (focusId && visibleEdges ? relatedIds(focusId, visibleEdges) : null), [focusId, visibleEdges]);
  const walkSteps = useMemo(() => (data ? buildWalkthrough(data) : []), [data]);

  // Graph used for explanations: the real trace plus any display-only group nodes / edges.
  const explainG = useMemo<Graph | null>(() => {
    if (!data) return null;
    const extraNodes = (graph?.nodes || []).filter((n) => n.members);
    const known = new Set(data.edges.map((e) => e.id));
    const extraEdges = [...(graph?.edges || []), ...(layout?.edges || [])].filter((e) => !known.has(e.id) && (known.add(e.id), true));
    return indexGraph({ ...data, nodes: [...data.nodes, ...extraNodes], edges: [...data.edges, ...extraEdges] });
  }, [data, graph, layout]);
  const edgeById = useMemo(() => {
    const m = new Map<string, FlowEdge>();
    if (explainG) for (const list of explainG.out.values()) for (const e of list) m.set(e.id, e);
    return m;
  }, [explainG]);

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) || null : null;
  const selectedEdge = selectedEdgeId ? edgeById.get(selectedEdgeId) || null : null;

  const expandGroup = useCallback((id: string) => {
    setExpandedGroups((s) => new Set(s).add(id));
    setSelectedNodeId(null);
  }, []);

  const openSource = useCallback((id: string) => {
    const n = nodeById.get(id);
    if (n?.members) { expandGroup(id); return; }
    if (!n || !n.filePath) return;
    const start = n.line || 1;
    onInspectFile(n.filePath, n.line ? { start, end: Math.max(start, n.endLine || start) } : null);
  }, [nodeById, onInspectFile, expandGroup]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAllBelowHandler = useCallback(() => {
    if (!data) return;
    const out = new Set(data.edges.map((e) => e.from));
    setCollapsed(new Set(data.nodes.filter((n) => (n.kind === "handler" || ((n.depth || 0) >= 3 && n.kind !== "middleware")) && out.has(n.id)).map((n) => n.id)));
  }, [data]);

  const selectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    if (id) setDetailsOpen(true);
  }, []);

  const selectEdge = useCallback((id: string | null) => {
    setSelectedEdgeId(id);
    if (id) setDetailsOpen(true);
  }, []);

  const goToNode = useCallback((id: string) => {
    // Make sure the node is visible (expand collapsed ancestors / unhide kind)
    if (layout && !layout.byId.has(id) && data) {
      const group = graph?.nodes.find((g) => g.members?.includes(id));
      if (group) setExpandedGroups((s) => new Set(s).add(group.id));
      const n = nodeById.get(id);
      if (n && hiddenKinds.has(kindGroup(n.kind))) setHiddenKinds((s) => { const x = new Set(s); x.delete(kindGroup(n.kind)); return x; });
      setCollapsed(new Set());
    }
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setDetailsOpen(true);
    setView("graph");
    requestAnimationFrame(() => requestAnimationFrame(() => canvasRef.current?.focusNode(id)));
  }, [layout, data, graph, nodeById, hiddenKinds]);

  const showWhy = useCallback((edgeId: string) => {
    setSelectedEdgeId(edgeId);
    setDetailsOpen(true);
  }, []);

  // ---------------------------------------------------------------- walkthrough
  const goStep = useCallback((i: number) => {
    if (!walkSteps.length) return;
    const idx = Math.max(0, Math.min(walkSteps.length - 1, i));
    setWalkIndex(idx);
    const st = walkSteps[idx];
    goToNode(st.node.id);
    // Keep the connection that led here in the details panel when there is one
    if (st.edge) setSelectedEdgeId(st.edge.id);
  }, [walkSteps, goToNode]);
  const stopWalk = useCallback(() => { setWalkIndex(null); setPlaying(false); }, []);
  useEffect(() => {
    if (!playing || walkIndex == null) return;
    if (walkIndex >= walkSteps.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => goStep(walkIndex + 1), 2200);
    return () => clearTimeout(t);
  }, [playing, walkIndex, walkSteps.length, goStep]);

  // Keyboard navigation inside the graph
  const onGraphKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!layout || !data) return;
    const key = e.key;
    if (key === "f" || key === "F") { canvasRef.current?.fit(); e.preventDefault(); return; }
    if (key === "+" || key === "=") { canvasRef.current?.zoomBy(1.25); e.preventDefault(); return; }
    if (key === "-" || key === "_") { canvasRef.current?.zoomBy(0.8); e.preventDefault(); return; }
    if (key === "Escape") { if (walkIndex != null) stopWalk(); else if (selectedEdgeId) setSelectedEdgeId(null); else setSelectedNodeId(null); return; }
    if (walkIndex != null && (key === "ArrowRight" || key === "ArrowLeft")) { e.preventDefault(); setPlaying(false); goStep(walkIndex + (key === "ArrowRight" ? 1 : -1)); return; }
    const cur = selectedNodeId && layout.byId.has(selectedNodeId) ? selectedNodeId : null;
    if (!cur) {
      if (key.startsWith("Arrow")) { goToNode(data.entryId); e.preventDefault(); }
      return;
    }
    if (key === "Enter") { openSource(cur); e.preventDefault(); return; }
    if (key === " ") { toggleCollapse(cur); e.preventDefault(); return; }
    let next: string | undefined;
    const outs = layout.edges.filter((x) => x.from === cur && x.to !== cur && !x.back).sort((a, b) => a.order - b.order);
    const ins = layout.edges.filter((x) => x.to === cur && x.from !== cur && !x.back);
    const n = layout.byId.get(cur)!;
    const col = layout.layers[n.layer] || [];
    const idx = col.indexOf(cur);
    if (key === "ArrowRight") next = outs[0]?.to;
    else if (key === "ArrowLeft") next = ins[0]?.from;
    else if (key === "ArrowDown") next = col[idx + 1];
    else if (key === "ArrowUp") next = col[idx - 1];
    if (next) { e.preventDefault(); setSelectedNodeId(next); setSelectedEdgeId(null); canvasRef.current?.focusNode(next); }
  }, [layout, data, selectedNodeId, selectedEdgeId, walkIndex, stopWalk, goStep, goToNode, openSource, toggleCollapse]);

  const detailCtx = useMemo<DetailCtx | null>(
    () => (data && explainG ? { trace: data, graph: explainG, nodeById, onGo: goToNode, onWhy: showWhy, loadFile, openRange } : null),
    [data, explainG, nodeById, goToNode, showWhy, loadFile, openRange],
  );

  // ---------------------------------------------------------------- render
  if (!repoUrl) {
    return <Shell><EmptyState icon={<Workflow size={28} />} title="No repository analyzed" body="Analyze a repository first; its API routes will appear here." /></Shell>;
  }

  return (
    <Shell>
      {/* Header */}
      <div className="shrink-0 border-b border-[#2a2222]/80 px-4 py-2.5 flex items-center gap-3 bg-[#121110]/90 backdrop-blur-md">
        <button onClick={() => setListOpen((o) => !o)} className={iconBtn} title={listOpen ? "Hide endpoint list" : "Show endpoint list"} aria-label="Toggle endpoint list">
          {listOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <Workflow size={15} className="text-[#ff5330] shrink-0" />
            <h2 className={`text-sm font-bold tracking-wide text-[#ff5330] ${MONO}`}>API Flow Tracing</h2>
            <span className={`hidden md:inline text-[9px] ${MONO} uppercase tracking-widest px-2 py-0.5 rounded bg-[#ff5330]/10 text-[#ff8c6b] border border-[#ff5330]/20`} title="Derived from source code without running it">Static analysis</span>
          </div>
          <p className={`text-[10px] text-stone-500 ${MONO} leading-snug truncate`}>
            Follow a request from its route through middleware, handlers and services to the database and the response.
          </p>
        </div>
        {selectedEp && (
          <div className="hidden lg:flex items-center gap-2 min-w-0 max-w-[40%]">
            <MethodBadge method={selectedEp.method} />
            <span className={`text-xs ${MONO} text-stone-200 truncate`} title={selectedEp.path}>{selectedEp.path}</span>
          </div>
        )}
        <button onClick={() => setDetailsOpen((o) => !o)} className={iconBtn} title={detailsOpen ? "Hide details" : "Show details"} aria-label="Toggle details panel" disabled={!selectedEp}>
          {detailsOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Endpoint list */}
        <aside className={`shrink-0 border-r border-[#2a2222]/80 bg-[#121110]/95 flex flex-col overflow-hidden transition-[width,opacity] duration-300 ease-out ${listOpen ? "w-[300px] xl:w-[320px] opacity-100" : "w-0 opacity-0 pointer-events-none"}`}>
          <div className="p-3 border-b border-[#2a2222] space-y-2.5">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-600" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search path, handler or file…"
                aria-label="Search endpoints"
                className={`w-full pl-8 pr-7 py-2 bg-[#1a1716] border border-[#2e2a27] rounded-md text-xs ${MONO} text-stone-200 placeholder:text-stone-600 focus:outline-none focus:border-[#ff5330]/50 transition`}
              />
              {query && <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-white" aria-label="Clear search"><X size={12} /></button>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {METHODS.filter((m) => methodCounts[m]).map((m) => {
                const on = methodFilter.has(m);
                return (
                  <button
                    key={m}
                    onClick={() => setMethodFilter((s) => { const x = new Set(s); if (x.has(m)) x.delete(m); else x.add(m); return x; })}
                    className={`text-[9px] ${MONO} font-bold px-1.5 py-0.5 rounded border transition`}
                    style={{ color: on ? "#090808" : METHOD_COLORS[m], background: on ? METHOD_COLORS[m] : `${METHOD_COLORS[m]}14`, borderColor: `${METHOD_COLORS[m]}55` }}
                    aria-pressed={on}
                  >
                    {m} <span className="opacity-70">{methodCounts[m]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2" role="listbox" aria-label="Discovered endpoints">
            {eps.status === "loading" || eps.status === "idle" ? (
              <div className="space-y-2 p-1">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-[58px] rounded-lg bg-[#181514] border border-[#221d1b] animate-pulse" />)}</div>
            ) : eps.status === "error" ? (
              <InlineError message={eps.error || "Could not load endpoints."} onRetry={() => setReloadKey((k) => k + 1)} />
            ) : endpoints.length === 0 ? (
              <div className="p-4 text-center">
                <div className={`text-xs text-stone-400 ${MONO} mb-1.5`}>No API routes found</div>
                <p className="text-[11px] text-stone-600 leading-relaxed">{eps.data?.note || "Supported: Express (app/router.METHOD, router.route, app.use mounting), Flask and FastAPI decorators."}</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className={`p-4 text-center text-xs text-stone-600 ${MONO}`}>No endpoints match your filters.</div>
            ) : (
              groups.map(([g, list]) => {
                const closed = collapsedGroups.has(g);
                return (
                  <div key={g} className="mb-1.5">
                    <button
                      onClick={() => setCollapsedGroups((s) => { const x = new Set(s); if (x.has(g)) x.delete(g); else x.add(g); return x; })}
                      className={`w-full flex items-center gap-1.5 px-1.5 py-1 text-[10px] ${MONO} uppercase tracking-wider text-stone-500 hover:text-stone-300`}
                    >
                      {closed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span className="truncate">{g}</span>
                      <span className="ml-auto text-stone-600">{list.length}</span>
                    </button>
                    {!closed && (
                      <div className="space-y-1">
                        {list.map((ep) => {
                          const active = selectedEp && (selectedEp.id ? selectedEp.id === ep.id : selectedEp.path === ep.path && selectedEp.method === ep.method);
                          return (
                            <button
                              key={ep.id || `${ep.method}-${ep.path}-${ep.filePath}-${ep.startLine}`}
                              role="option"
                              aria-selected={!!active}
                              onClick={() => selectEndpoint(ep)}
                              className={`group w-full text-left px-2.5 py-2 rounded-lg border transition ${active ? "bg-[#ff5330]/12 border-[#ff5330]/50" : "bg-[#181514] border-[#2b2523] hover:border-[#ff5330]/30 hover:bg-[#1f1c1a]"}`}
                            >
                              <div className="flex items-center gap-2">
                                <MethodBadge method={ep.method} />
                                <PathText path={ep.path} active={!!active} />
                              </div>
                              <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${MONO} text-stone-500 min-w-0`}>
                                <span className="truncate">{ep.handler ? `→ ${ep.handler}` : "inline handler"}</span>
                                {ep.middleware && ep.middleware.length > 0 && <span className="shrink-0 text-[#f5b347]/80" title={ep.middleware.join(" → ")}>· {ep.middleware.length} mw</span>}
                                {ep.confidence === "low" && <span className="shrink-0 text-amber-500/80" title="Handler could not be resolved to a definition">· unresolved</span>}
                                {ep.mountResolved === false && <span className="shrink-0 text-amber-500/80" title="Router mount point not found; URL prefix may be incomplete">· prefix?</span>}
                              </div>
                              <div className={`text-[9px] ${MONO} text-stone-600 truncate`}>{ep.filePath}:{ep.startLine}</div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className={`border-t border-[#2a2222] px-3 py-2 text-[10px] text-stone-500 ${MONO} flex items-center justify-between`}>
            <span>{filtered.length} / {endpoints.length} endpoints</span>
            <button onClick={() => setReloadKey((k) => k + 1)} className="hover:text-white flex items-center gap-1" title="Re-scan endpoints"><RefreshCw size={11} /> Rescan</button>
          </div>
        </aside>

        {/* Main */}
        <section className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#090808]">
          {selectedEp && (
            <div className="shrink-0 border-b border-[#2a2222] px-3 py-2 flex flex-wrap items-center gap-2 bg-[#121110]/80">
              <div className="flex rounded-md border border-[#2e2a27] overflow-hidden">
                <button onClick={() => setView("graph")} className={tabBtn(view === "graph")}><GitBranch size={12} /> Graph</button>
                <button onClick={() => setView("steps")} className={tabBtn(view === "steps")}><ListTree size={12} /> Steps</button>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {LEGEND_GROUPS.map((g) => {
                  const off = hiddenKinds.has(g.id);
                  const count = data ? data.nodes.filter((n) => n.id !== data.entryId && kindGroup(n.kind) === g.id).length : 0;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setHiddenKinds((s) => { const x = new Set(s); if (x.has(g.id)) x.delete(g.id); else x.add(g.id); return x; })}
                      disabled={!count}
                      className={`flex items-center gap-1.5 text-[10px] ${MONO} px-2 py-1 rounded-md border transition disabled:opacity-35 ${off ? "border-[#2a2222] text-stone-600 line-through" : "border-[#2e2a27] text-stone-300 hover:border-[#ff5330]/40"}`}
                      title={off ? `Show ${g.label}` : `Hide ${g.label}`}
                      aria-pressed={!off}
                    >
                      <span className="w-2 h-2 rounded-sm" style={{ background: off ? "#3d3835" : g.color }} />
                      {g.label}
                      <span className="text-stone-600">{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => { if (walkIndex != null) stopWalk(); else { setView("graph"); goStep(0); } }}
                  disabled={!walkSteps.length}
                  className={`mr-1 text-[10.5px] ${MONO} px-2 py-1 rounded-md border transition inline-flex items-center gap-1.5 disabled:opacity-30 ${walkIndex != null ? "bg-[#ff5330] text-white border-[#ff5330]" : "bg-[#1d1918] text-stone-300 border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40"}`}
                  title="Step through the request in execution order"
                >
                  <Play size={11} /> {walkIndex != null ? "Exit walkthrough" : "Walk through"}
                </button>
                <label className={`hidden md:flex items-center gap-1.5 text-[10px] ${MONO} text-stone-500 mr-1`} title="Maximum call depth to follow">
                  Depth
                  <select
                    value={depth}
                    onChange={(e) => { const d = Number(e.target.value); setDepth(d); if (selectedEp) runTrace(selectedEp, d); }}
                    className="bg-[#1a1716] border border-[#2e2a27] rounded px-1 py-0.5 text-stone-300 focus:outline-none focus:border-[#ff5330]/50"
                  >
                    {[3, 5, 8, 12].map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
                {view === "graph" && (
                  <>
                    <button className={iconBtn} onClick={() => canvasRef.current?.zoomBy(0.8)} title="Zoom out (-)" aria-label="Zoom out"><Minus size={14} /></button>
                    <button className={iconBtn} onClick={() => canvasRef.current?.zoomBy(1.25)} title="Zoom in (+)" aria-label="Zoom in"><Plus size={14} /></button>
                    <button className={iconBtn} onClick={() => canvasRef.current?.fit()} title="Fit to screen (F)" aria-label="Fit to screen"><Maximize2 size={13} /></button>
                    <button className={iconBtn} onClick={collapseAllBelowHandler} title="Collapse deep calls" aria-label="Collapse deep calls"><ChevronsDownUp size={14} /></button>
                    <button className={iconBtn} onClick={() => setCollapsed(new Set())} title="Expand all" aria-label="Expand all" disabled={!collapsed.size}><ChevronsUpDown size={14} /></button>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 relative min-h-0 outline-none" tabIndex={0} onKeyDown={view === "graph" ? onGraphKey : undefined} aria-label="Flow graph area">
            {!selectedEp ? (
              <Intro count={endpoints.length} loading={eps.status === "loading"} />
            ) : trace.status === "error" ? (
              <div className="absolute inset-0 flex items-center justify-center p-6"><InlineError message={trace.error || "Trace failed."} onRetry={() => runTrace(selectedEp, depth)} /></div>
            ) : !data || (trace.status === "loading" && !layout) ? (
              <TraceSkeleton />
            ) : !layout ? (
              <EmptyState icon={<Workflow size={26} />} title="Nothing to draw" body="This endpoint produced no traceable steps." />
            ) : (
              <>
                {view === "graph" ? (
                  <FlowCanvas
                    ref={canvasRef}
                    layout={layout}
                    selectedId={selectedNodeId}
                    highlight={highlight}
                    collapsed={collapsed}
                    onSelect={selectNode}
                    selectedEdgeId={selectedEdgeId}
                    onSelectEdge={selectEdge}
                    onHover={setHoverId}
                    onToggleCollapse={toggleCollapse}
                    onOpenSource={openSource}
                  />
                ) : (
                  <WalkthroughView steps={walkSteps} selectedId={selectedNodeId} nodeById={nodeById} onSelect={selectNode} onGo={goToNode} onPlay={(i) => { setView("graph"); goStep(i); }} />
                )}
                {trace.status === "loading" && (
                  <div className="absolute inset-0 bg-[#090808]/50 flex items-center justify-center z-20"><Spinner label="Re-tracing…" /></div>
                )}
                <div className="absolute top-3 left-3 z-10 flex flex-col gap-2 max-w-[min(520px,70%)] pointer-events-none">
                  <StatsBar trace={data} />
                  {data.notes && data.notes.length > 0 ? (
                    <NotesPanel notes={data.notes} onGo={goToNode} analysis={data.analysis} nodeById={nodeById} />
                  ) : data.warnings.length > 0 ? (
                    <NotesPanel notes={data.warnings.map((w, i) => ({ id: `w${i}`, severity: "warn" as const, title: w.split(/[.;(]/)[0], detail: w }))} onGo={goToNode} analysis={data.analysis} nodeById={nodeById} />
                  ) : null}
                </div>
                {view === "graph" && walkIndex != null && explainG && (
                  <WalkthroughBar steps={walkSteps} index={walkIndex} nodeById={nodeById} playing={playing} onIndex={(i) => { setPlaying(false); goStep(i); }} onTogglePlay={() => { if (walkIndex >= walkSteps.length - 1) { goStep(0); } setPlaying((p) => !p); }} onClose={stopWalk} onGo={goToNode} />
                )}
                {view === "graph" && walkIndex == null && (
                  <div className={`absolute bottom-3 left-3 z-10 hidden 2xl:block text-[9.5px] ${MONO} text-stone-600 bg-[#121110]/70 rounded-md px-2 py-1 border border-[#2a2222]/60 pointer-events-none`}>
                    Scroll to zoom · drag to pan · click a node or arrow to explain it · double-click opens source · arrows navigate · <span className="text-stone-500">dashed = conditional</span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* Details */}
        {selectedEp && (
          <aside className={`shrink-0 border-l border-[#2a2222]/80 bg-[#121110]/95 overflow-hidden transition-[width,opacity] duration-300 ease-out ${detailsOpen ? "w-[320px] xl:w-[380px] opacity-100" : "w-0 opacity-0 pointer-events-none"}`}>
            <div className="w-[320px] xl:w-[380px] h-full overflow-y-auto" aria-live="polite">
              {selectedEdge && detailCtx ? (
                <EdgeDetails key={selectedEdge.id} edge={selectedEdge} ctx={detailCtx} onClose={() => setSelectedEdgeId(null)} />
              ) : selectedNode && detailCtx ? (
                <NodeDetails key={selectedNode.id} node={selectedNode} ctx={detailCtx} onExpandGroup={expandGroup} onClose={() => setSelectedNodeId(null)} collapsed={collapsed.has(selectedNode.id)} onToggleCollapse={() => toggleCollapse(selectedNode.id)} />
              ) : (
                <EndpointSummary key={selectedEp.id || selectedEp.path} ep={data?.endpoint || selectedEp} ctx={detailCtx} onOpen={() => onInspectFile(selectedEp.filePath, { start: selectedEp.startLine, end: Math.max(selectedEp.startLine, selectedEp.endLine) })} />
              )}
            </div>
          </aside>
        )}
      </div>
    </Shell>
  );
}

// ==================================================================== pieces

const iconBtn = "w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md bg-[#1d1918] text-stone-400 border border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40 transition disabled:opacity-30 disabled:pointer-events-none";
const tabBtn = (on: boolean) => `flex items-center gap-1.5 px-2.5 py-1 text-[11px] ${MONO} transition ${on ? "bg-[#ff5330] text-white" : "bg-[#1d1918] text-stone-400 hover:text-white"}`;

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full bg-[#090808] text-stone-200 font-sans selection:bg-[#ff5330]/20">{children}</div>;
}

function MethodBadge({ method }: { method: string }) {
  const c = METHOD_COLORS[method] || "#a8a29e";
  return <span className={`shrink-0 text-[9px] ${MONO} font-extrabold uppercase px-1.5 py-0.5 rounded w-[46px] text-center`} style={{ backgroundColor: `${c}1f`, color: c }}>{method}</span>;
}

function PathText({ path, active }: { path: string; active: boolean }) {
  const parts = path.split(/(\/:[^/]+|\/\{[^/]+\}|\/<[^/]+>)/g).filter(Boolean);
  return (
    <span className={`text-xs ${MONO} font-semibold truncate ${active ? "text-[#ffb39c]" : "text-stone-200"}`} title={path}>
      {parts.map((p, i) => (/^\/(:|\{|<)/.test(p) ? <span key={i} className="text-[#ff8c6b]/80">{p}</span> : <span key={i}>{p}</span>))}
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-6 h-6 border-2 border-[#ff5330] border-t-transparent rounded-full animate-spin" />
      <span className={`text-[10px] ${MONO} text-stone-500`}>{label}</span>
    </div>
  );
}

function TraceSkeleton() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex items-center gap-6 opacity-60">
        {[1, 2, 3, 2].map((n, c) => (
          <div key={c} className="flex flex-col gap-3">
            {Array.from({ length: n }).map((_, i) => <div key={i} className="w-36 h-12 rounded-lg bg-[#181514] border border-[#2a2422] animate-pulse" style={{ animationDelay: `${c * 120}ms` }} />)}
          </div>
        ))}
      </div>
      <div className="absolute bottom-1/4"><Spinner label="Tracing static call paths…" /></div>
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
      <div className="text-[#ff5330]/70 mb-3">{icon}</div>
      <div className={`text-sm ${MONO} text-stone-300 mb-1.5`}>{title}</div>
      <p className="text-xs text-stone-500 max-w-md leading-relaxed">{body}</p>
    </div>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="m-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-center max-w-sm">
      <div className={`flex items-center justify-center gap-1.5 text-xs text-red-300 ${MONO} mb-1`}><AlertTriangle size={13} /> Something went wrong</div>
      <p className="text-[11px] text-stone-400 mb-2.5 break-words">{message}</p>
      <button onClick={onRetry} className={`text-[11px] ${MONO} px-3 py-1 rounded-md bg-[#1d1918] border border-[#2e2a27] text-stone-300 hover:text-white hover:border-[#ff5330]/40 inline-flex items-center gap-1.5`}><RefreshCw size={11} /> Retry</button>
    </div>
  );
}

function Intro({ count, loading }: { count: number; loading: boolean }) {
  const stages = [
    { k: "endpoint", t: "Route" },
    { k: "middleware", t: "Middleware" },
    { k: "handler", t: "Handler" },
    { k: "service", t: "Services" },
    { k: "database", t: "Data / APIs" },
    { k: "response", t: "Response" },
  ];
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
      <div className="flex flex-wrap items-center justify-center gap-1.5 mb-6">
        {stages.map((s, i) => (
          <div key={s.k} className="flex items-center gap-1.5">
            <div className={`px-2.5 py-1.5 rounded-lg border text-[10px] ${MONO}`} style={{ borderColor: `${KIND_META[s.k].color}55`, color: KIND_META[s.k].color, background: KIND_META[s.k].bg }}>{s.t}</div>
            {i < stages.length - 1 && <ArrowRight size={12} className="text-stone-600" />}
          </div>
        ))}
      </div>
      <div className={`text-sm ${MONO} text-stone-200 mb-1.5`}>{loading ? "Discovering endpoints…" : count ? "Pick an endpoint to trace its request flow" : "No endpoints to trace"}</div>
      <p className="text-xs text-stone-500 max-w-lg leading-relaxed">
        Every arrow is backed by a line of code: a mount, a middleware registration or a function call. Calls that can’t be resolved statically
        (callbacks, dynamic dispatch) are listed on the node instead of being guessed.
      </p>
    </div>
  );
}

function StatsBar({ trace }: { trace: FlowTrace }) {
  const responses = trace.nodes.filter((n) => n.kind === "response");
  const codes = [...new Set(responses.map((r) => r.status))];
  return (
    <div className={`pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] ${MONO} text-stone-400 bg-[#121110]/85 border border-[#2a2222]/70 rounded-lg px-2.5 py-1.5 backdrop-blur-md shadow-xl`}>
      <span><span className="text-stone-200">{trace.stats.nodes}</span> steps</span>
      <span><span className="text-stone-200">{trace.stats.maxDepth}</span> deep</span>
      {codes.length > 0 && (
        <span className="flex items-center gap-1">
          {codes.map((c) => <span key={String(c)} className="px-1 rounded" style={{ color: statusColor(c), background: `${statusColor(c)}18` }}>{c}</span>)}
        </span>
      )}
      {trace.stats.unresolved > 0 && <span className="text-amber-400/90">{trace.stats.unresolved} unresolved</span>}
      {typeof trace.ms === "number" && <span className="text-stone-600">{trace.ms} ms</span>}
      <span className="text-[9px] uppercase tracking-wider px-1.5 rounded border border-[#3d2c28] text-[#ff8c6b]/90 cursor-help" title={trace.analysis?.description || "Derived from the source code without running it."}>Static · not a runtime trace</span>
    </div>
  );
}

function TabBar<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 px-4 pt-2 border-b border-[#221d1b]" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`text-[10px] ${MONO} uppercase tracking-wider px-2 py-1.5 -mb-px border-b-2 transition ${value === t.id ? "border-[#ff5330] text-[#ff8c6b]" : "border-transparent text-stone-500 hover:text-stone-300"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-[#221d1b]">
      <div className={`text-[9px] ${MONO} uppercase tracking-widest text-stone-500 mb-2`}>{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className={`flex gap-3 text-[11px] ${MONO} py-0.5`}>
      <span className="text-stone-500 w-20 shrink-0">{k}</span>
      <span className="text-stone-300 min-w-0 break-all">{v}</span>
    </div>
  );
}

function NodeLink({ node, edge, dir, onGo, onWhy }: { node: FlowNode; edge: FlowEdge; dir: "in" | "out"; onGo: (id: string) => void; onWhy: (edgeId: string) => void }) {
  const meta = KIND_META[node.kind] || KIND_META.function;
  const color = node.kind === "response" ? statusColor(node.status) : meta.color;
  return (
    <div className="flex items-center gap-1 group">
      <button onClick={() => onGo(node.id)} className="min-w-0 flex-1 text-left flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#1d1918] border border-transparent hover:border-[#2e2a27] transition">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="min-w-0 flex-1">
          <span className={`block text-[11px] ${MONO} text-stone-200 truncate group-hover:text-white`}>{node.name}</span>
          <span className={`block text-[9.5px] ${MONO} text-stone-500 truncate`}>
            {dir === "out" ? EDGE_VERB[edge.kind] || edge.kind : "from"}{edge.lines.length ? ` · L${edge.lines.join(", ")}` : ""}{edge.conditional ? " · conditional" : ""}{edge.count > 1 ? ` · ×${edge.count}` : ""}
          </span>
        </span>
      </button>
      <button onClick={() => onWhy(edge.id)} className={`shrink-0 text-[9.5px] ${MONO} px-1.5 py-1 rounded border border-[#2e2a27] text-stone-500 hover:text-[#ff8c6b] hover:border-[#ff5330]/40 transition`} title="Why are these connected?">Why?</button>
    </div>
  );
}

type DetailCtx = {
  trace: FlowTrace;
  graph: Graph;
  nodeById: Map<string, FlowNode>;
  onGo: (id: string) => void;
  onWhy: (edgeId: string) => void;
  loadFile: FileLoader;
  openRange: OpenRange;
};

function NodeDetails({ node, ctx, onClose, collapsed, onToggleCollapse, onExpandGroup }: {
  node: FlowNode; ctx: DetailCtx; onExpandGroup: (id: string) => void; onClose: () => void; collapsed: boolean; onToggleCollapse: () => void;
}) {
  const { trace, graph, nodeById, onGo, onWhy, loadFile, openRange } = ctx;
  const [tab, setTab] = useState<"explain" | "source" | "links">("explain");
  const meta = KIND_META[node.kind] || KIND_META.function;
  const color = node.kind === "response" ? statusColor(node.status) : meta.color;
  const outgoing = (graph.out.get(node.id) || []).filter((e) => e.to !== node.id);
  const incoming = (graph.inc.get(node.id) || []).filter((e) => e.from !== node.id);
  const ex = useMemo(() => explainNode(node, graph, trace), [node, graph, trace]);
  const hasSource = !node.members && !!node.filePath && node.line > 0;
  const callLines = outgoing.filter((e) => e.file === node.filePath).flatMap((e) => e.lines);
  const toneCls = ex.confidence.tone === "ok" ? "text-emerald-400" : ex.confidence.tone === "warn" ? "text-amber-400" : "text-stone-400";
  return (
    <div>
      <div className="px-4 pt-4 pb-3 border-b border-[#221d1b]">
        <div className="flex items-start gap-2">
          <span className={`text-[9px] ${MONO} uppercase tracking-widest px-1.5 py-0.5 rounded border`} style={{ color, borderColor: `${color}55`, background: `${color}12` }}>
            {node.kind === "response" ? `Response ${node.status ?? ""}` : node.members ? "Middleware group" : meta.label}
          </span>
          <span className={`text-[9px] ${MONO} uppercase tracking-wider ${toneCls} cursor-help`} title={ex.confidence.text}>● {ex.confidence.label}</span>
          <button onClick={onClose} className="ml-auto text-stone-500 hover:text-white" aria-label="Close node details"><X size={14} /></button>
        </div>
        <div className={`mt-2 text-sm ${MONO} font-semibold text-white break-all`}>{node.name}</div>
        {node.filePath && <div className={`mt-0.5 text-[10px] ${MONO} text-stone-500 break-all`}>{node.filePath}{node.line ? `:${node.line}${node.endLine && node.endLine !== node.line ? `–${node.endLine}` : ""}` : ""}</div>}
        {node.members && (
          <ol className="mt-3 space-y-1">
            {node.members.map((m, i) => {
              const mn = nodeById.get(m);
              return mn ? <li key={m} className={`text-[11px] ${MONO} flex gap-2`}><span className="text-stone-600 w-4 text-right">{i + 1}</span><span className="text-[#f5b347]/90 break-all">{mn.name}</span><span className="ml-auto text-stone-600 shrink-0">{shortFile(mn.filePath)}:{mn.line}</span></li> : null;
            })}
          </ol>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {node.members && (
            <button onClick={() => onExpandGroup(node.id)} className={`text-[11px] ${MONO} px-2.5 py-1.5 rounded-md bg-[#ff5330] text-white hover:bg-[#ff6a4a] transition`}>Expand group</button>
          )}
          {hasSource && (
            <button onClick={() => openRange(node.filePath, node.line, Math.max(node.line, node.endLine || node.line))} className={`text-[11px] ${MONO} px-2.5 py-1.5 rounded-md bg-[#ff5330] text-white hover:bg-[#ff6a4a] transition inline-flex items-center gap-1.5`}>
              <Code2 size={12} /> Open in editor
            </button>
          )}
          {outgoing.length > 0 && !node.members && (
            <button onClick={onToggleCollapse} className={`text-[11px] ${MONO} px-2.5 py-1.5 rounded-md bg-[#1d1918] border border-[#2e2a27] text-stone-300 hover:text-white hover:border-[#ff5330]/40 transition`}>
              {collapsed ? "Expand subtree" : "Collapse subtree"}
            </button>
          )}
        </div>
      </div>

      <TabBar tabs={[{ id: "explain", label: "Explain" }, ...(hasSource ? [{ id: "source" as const, label: "Source" }] : []), { id: "links", label: `Connections ${incoming.length + outgoing.length}` }]} value={tab} onChange={setTab} />

      {tab === "explain" && (
        <>
          <Section title="What it does">
            <SentenceList items={ex.what} nodeById={nodeById} onGo={onGo} />
          </Section>
          {ex.why.length > 0 && (
            <Section title="Why it's in this flow">
              <SentenceList items={ex.why} nodeById={nodeById} onGo={onGo} bullets />
              {incoming.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {incoming.map((e) => (
                    <button key={e.id} onClick={() => onWhy(e.id)} className={`text-[10px] ${MONO} px-1.5 py-0.5 rounded border border-[#2e2a27] text-stone-400 hover:text-[#ff8c6b] hover:border-[#ff5330]/40`}>
                      Why connected to {nodeById.get(e.from)?.name.slice(0, 22) || "caller"}?
                    </button>
                  ))}
                </div>
              )}
            </Section>
          )}
          <Section title="Where in the code">
            <EvidenceList items={ex.evidence} onOpen={openRange} />
            {hasSource && (
              <div className="mt-2">
                <CodePreview file={node.filePath} range={[node.line, Math.max(node.line, node.endLine || node.line)]} focus={callLines.length ? [] : [node.line]} loadFile={loadFile} onOpen={openRange} maxLines={14} />
              </div>
            )}
            {node.params && node.params.length > 0 && <div className="mt-2"><Row k="Params" v={`(${node.params.join(", ")})`} /></div>}
            {node.wrapper && <Row k="Wrapped by" v={node.wrapper} />}
            {node.package && <Row k="Package" v={node.package} />}
            {node.truncated && <Row k="Note" v={<span className="text-amber-400">Depth limit reached. Increase Depth to follow further.</span>} />}
          </Section>
        </>
      )}

      {tab === "source" && hasSource && (
        <div className="p-3">
          <CodePreview file={node.filePath} range={[node.line, Math.max(node.line, node.endLine || node.line)]} focus={callLines} loadFile={loadFile} onOpen={openRange} maxLines={48} />
          {callLines.length > 0 && <p className={`mt-2 text-[10px] ${MONO} text-stone-500`}>Highlighted: the lines where this function calls the next steps.</p>}
        </div>
      )}

      {tab === "links" && (
        <>
          {incoming.length > 0 && (
            <Section title={`Reached from (${incoming.length})`}>
              {incoming.map((e) => { const n = nodeById.get(e.from); return n ? <NodeLink key={e.id} node={n} edge={e} dir="in" onGo={onGo} onWhy={onWhy} /> : null; })}
            </Section>
          )}
          {outgoing.length > 0 && (
            <Section title={`Next steps (${outgoing.length})`}>
              {outgoing.map((e) => { const n = nodeById.get(e.to); return n ? <NodeLink key={e.id} node={n} edge={e} dir="out" onGo={onGo} onWhy={onWhy} /> : null; })}
            </Section>
          )}
          {!incoming.length && !outgoing.length && <div className={`p-4 text-[11px] ${MONO} text-stone-500`}>No connections.</div>}
        </>
      )}

      {node.unresolved && node.unresolved.length > 0 && (
        <Section title={`Calls the analyzer could not follow (${node.unresolved.length})`}>
          <p className="text-[10.5px] text-stone-500 leading-snug mb-2">These calls exist in the code, but their target is decided at runtime, so they are not drawn. The real flow may continue through them.</p>
          <ul className="space-y-1">
            {node.unresolved.map((u, i) => (
              <li key={i}>
                <button onClick={() => node.filePath && openRange(node.filePath, u.line, u.line)} className={`w-full text-left text-[11px] ${MONO} flex gap-2 hover:bg-[#1d1918] rounded px-1`}>
                  <span className="text-amber-400/90 break-all">{u.label}()</span>
                  <span className="text-stone-600 shrink-0">L{u.line}</span>
                  <span className="text-stone-500 truncate" title={u.reason}>{u.reason}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {node.libraryCalls && node.libraryCalls.length > 0 && (
        <Section title="Library calls (not drawn)">
          <div className="flex flex-wrap gap-1">{node.libraryCalls.map((l) => <span key={l} className={`text-[10px] ${MONO} px-1.5 py-0.5 rounded bg-[#1a1716] border border-[#2e2a27] text-stone-400`}>{l}</span>)}</div>
        </Section>
      )}
    </div>
  );
}

function EdgeDetails({ edge, ctx, onClose }: { edge: FlowEdge; ctx: DetailCtx; onClose: () => void }) {
  const { graph, nodeById, onGo, loadFile, openRange } = ctx;
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  const ex = useMemo(() => (from && to ? explainEdge(edge, graph) : null), [edge, graph, from, to]);
  if (!from || !to || !ex) return null;
  return (
    <div>
      <div className="px-4 pt-4 pb-3 border-b border-[#221d1b]">
        <div className="flex items-start gap-2">
          <span className={`text-[9px] ${MONO} uppercase tracking-widest px-1.5 py-0.5 rounded border border-[#ff5330]/40 text-[#ff8c6b] bg-[#ff5330]/10`}>Why connected · {ex.title}</span>
          <button onClick={onClose} className="ml-auto text-stone-500 hover:text-white" aria-label="Close connection details"><X size={14} /></button>
        </div>
        <div className={`mt-2.5 flex items-center gap-2 text-[11px] ${MONO} flex-wrap`}>
          <button onClick={() => onGo(from.id)} className="px-1.5 py-0.5 rounded border border-[#2e2a27] hover:border-[#ff5330]/40 break-all" style={{ color: nodeColor(from) }}>{from.name}</button>
          <span className="text-stone-500">→</span>
          <button onClick={() => onGo(to.id)} className="px-1.5 py-0.5 rounded border border-[#2e2a27] hover:border-[#ff5330]/40 break-all" style={{ color: nodeColor(to) }}>{to.name}</button>
        </div>
      </div>
      <Section title="Explanation">
        <SentenceList items={ex.sentences} nodeById={nodeById} onGo={onGo} />
      </Section>
      {ex.evidence.length > 0 && (
        <Section title="Evidence in the source">
          <EvidenceList items={ex.evidence} onOpen={openRange} />
        </Section>
      )}
      {edge.file && edge.lines.length > 0 && (
        <div className="p-3 border-b border-[#221d1b]">
          <CodePreview file={edge.file} range={[edge.lines[0], edge.lines[edge.lines.length - 1]]} focus={edge.lines} loadFile={loadFile} onOpen={openRange} maxLines={12} />
        </div>
      )}
      {!edge.lines.length && (
        <p className={`px-4 py-3 text-[10.5px] ${MONO} text-stone-500`}>This is a display link (grouped or hidden steps in between). Select the individual steps for line-level evidence.</p>
      )}
    </div>
  );
}

function EndpointSummary({ ep, ctx, onOpen }: { ep: Endpoint; ctx: DetailCtx | null; onOpen: () => void }) {
  const [tab, setTab] = useState<"explain" | "route">("explain");
  const ex = useMemo(() => (ctx ? explainEndpoint(ctx.trace) : null), [ctx]);
  return (
    <div>
      <div className="px-4 pt-4 pb-3 border-b border-[#221d1b]">
        <div className="flex items-center gap-2"><MethodBadge method={ep.method} /><span className={`text-[9px] ${MONO} uppercase tracking-widest text-stone-500`}>{ep.framework}</span></div>
        <div className={`mt-2 text-sm ${MONO} font-semibold text-white break-all`}>{ep.path}</div>
        <p className="mt-1 text-[11px] text-stone-500">Click any node or arrow in the graph for its explanation.</p>
        <button onClick={onOpen} className={`mt-3 text-[11px] ${MONO} px-2.5 py-1.5 rounded-md bg-[#1d1918] border border-[#2e2a27] text-stone-300 hover:text-white hover:border-[#ff5330]/40 transition inline-flex items-center gap-1.5`}>
          <Code2 size={12} /> Route definition
        </button>
      </div>
      <TabBar tabs={[{ id: "explain", label: "Explain this API" }, { id: "route", label: "Route details" }]} value={tab} onChange={setTab} />

      {tab === "explain" && (
        !ctx || !ex ? <div className={`p-4 text-[11px] ${MONO} text-stone-500`}>Tracing…</div> : (
          <>
            <Section title="Purpose">
              <SentenceList items={ex.purpose} nodeById={ctx.nodeById} onGo={ctx.onGo} />
            </Section>
            <Section title="Overview">
              <SentenceList items={ex.overview} nodeById={ctx.nodeById} onGo={ctx.onGo} />
            </Section>
            {ex.journey.length > 0 && (
              <Section title="What happens inside">
                <SentenceList items={ex.journey} nodeById={ctx.nodeById} onGo={ctx.onGo} bullets />
              </Section>
            )}
            {ex.outcomes.length > 0 && (
              <Section title="Possible outcomes">
                {ex.outcomes.map(({ node: r, conditional, via }) => (
                  <button key={r.id} onClick={() => ctx.onGo(r.id)} className={`w-full text-left flex items-center gap-2 py-1 text-[11px] ${MONO} hover:text-white text-stone-300`}>
                    <span className="px-1.5 rounded text-[10px] font-bold shrink-0" style={{ color: r.kind === "error" ? "#ef4444" : statusColor(r.status), background: `${r.kind === "error" ? "#ef4444" : statusColor(r.status)}18` }}>{r.kind === "error" ? (r.status ?? "ERR") : r.status}</span>
                    <span className="truncate">{r.kind === "error" ? r.name : `${r.sender || "response"}`}{via ? <span className="text-stone-500"> · from {via.name}</span> : null}</span>
                    <span className={`ml-auto shrink-0 text-[9px] uppercase tracking-wider ${conditional ? "text-amber-400/80" : "text-emerald-400/80"}`}>{conditional ? "if…" : "always*"}</span>
                  </button>
                ))}
                <p className={`mt-1.5 text-[9.5px] ${MONO} text-stone-600`}>if… = only on some paths · always* = not inside a condition in its function</p>
              </Section>
            )}
            {(ex.data.reads.length + ex.data.writes.length + ex.data.other.length + ex.data.external.length) > 0 && (
              <Section title="Data & external systems">
                {([["Reads", ex.data.reads], ["Writes", ex.data.writes], ["Queries", ex.data.other], ["External", ex.data.external]] as const).map(([label, list]) => list.length ? (
                  <div key={label} className="flex gap-2 py-0.5">
                    <span className={`w-16 shrink-0 text-[10px] ${MONO} text-stone-500`}>{label}</span>
                    <span className="flex flex-wrap gap-1">{list.map((n) => <button key={n.id} onClick={() => ctx.onGo(n.id)} className={`text-[10.5px] ${MONO} px-1 rounded hover:underline`} style={{ color: nodeColor(n), background: `${nodeColor(n)}14` }}>{n.name}</button>)}</span>
                  </div>
                ) : null)}
              </Section>
            )}
            {ex.caveat && (
              <Section title="Limits of this explanation">
                <SentenceList items={[ex.caveat]} nodeById={ctx.nodeById} onGo={ctx.onGo} />
              </Section>
            )}
            <p className={`px-4 py-3 text-[10px] ${MONO} text-stone-600 leading-relaxed`}>
              Generated from static analysis of the source. Nothing was executed; labels such as “inferred from name” mark hints that are not proven by code.
            </p>
          </>
        )
      )}

      {tab === "route" && (
        <>
          <Section title="Route">
            <Row k="Defined in" v={`${ep.filePath}:${ep.startLine}`} />
            {ep.routePath && ep.routePath !== ep.path && <Row k="Local path" v={ep.routePath} />}
            <Row k="Handler" v={ep.handler || "inline function"} />
            {ep.handlerFile && <Row k="Handler at" v={`${shortFile(ep.handlerFile)}:${ep.handlerLine}`} />}
            {ep.mountResolved === false && <Row k="Prefix" v={<span className="text-amber-400">mount point not found</span>} />}
          </Section>
          {ep.mountChain && ep.mountChain.length > 0 && (
            <Section title="Mounted via">
              {ep.mountChain.map((m, i) => (
                <button key={i} onClick={() => ctx?.openRange(m.file, m.line, m.line)} className="w-full text-left hover:bg-[#1d1918] rounded"><Row k={m.prefix} v={`${m.file}:${m.line}`} /></button>
              ))}
            </Section>
          )}
          {ep.middleware && ep.middleware.length > 0 && (
            <Section title={`Middleware chain (${ep.middleware.length})`}>
              <ol className="space-y-1">
                {ep.middleware.map((m, i) => (
                  <li key={i} className={`text-[11px] ${MONO} text-stone-300 flex gap-2`}><span className="text-stone-600 w-4 text-right">{i + 1}</span><span className="text-[#f5b347]/90 break-all">{m}</span></li>
                ))}
              </ol>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
