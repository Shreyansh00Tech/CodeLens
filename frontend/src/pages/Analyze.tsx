import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { editor as MonacoEditor } from "monaco-editor";
import Navbar from "../components/Navbar";
import ForceGraph from "../components/Graph";
import SunburstGraph from "../components/SunburstGraph";
import RepoHealthPanel from "../components/RepoHealthPanel";
import DiagnosticsPanel from "../components/DiagnosticPanel";
import ApiFlowPanel from "../components/ApiFlowPanel";
import QnAPanel from "../components/QnAPanel";
import { ImpactPanel, NodeContextMenu, type MenuState } from "../components/ImpactPanel";
import type { Citation } from "../components/Markdown";
import type { DiagnosticsData, Endpoint, GraphData, GraphHandle, Highlight, ImpactResult } from "../lib/types";
import { buildAdjacency, cycleHighlight, fileName, simulateImpact } from "../lib/graphAnalysis";

const Editor = lazy(async () => {
  const [mod] = await Promise.all([import("@monaco-editor/react"), import("../lib/monacoSetup")]);
  return { default: mod.default };
});

type Filter = "ALL" | "CIRCULAR" | "GOD_MODULES" | "DEAD_CODE";
type View = "NODE" | "SUNBURST";
type Toast = { id: number; kind: "error" | "info" | "success"; text: string };

const API =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ||
  "http://localhost:8080";

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", json: "json", md: "markdown", css: "css", html: "html", go: "go", java: "java", rb: "ruby", rs: "rust", yml: "yaml", yaml: "yaml",
};
const langFor = (p: string) => LANG_BY_EXT[p.split(".").pop()?.toLowerCase() || ""] || "plaintext";

const LOADING_STEPS = ["Cloning repository", "Parsing source files", "Resolving imports", "Running diagnostics"];

function EmptyState({ onPick }: { onPick: (url: string) => void }) {
  const examples = ["https://github.com/expressjs/express", "https://github.com/pallets/flask", "https://github.com/vitejs/vite"];
  return (
    <div className="flex-1 flex flex-col items-center justify-center relative w-full h-full select-none overflow-hidden bg-[#090808]">
      <div className="absolute inset-0 opacity-15 pointer-events-none" style={{ backgroundImage: "radial-gradient(#ff5330 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      <div className="relative flex items-center justify-center mb-6">
        <div className="absolute w-36 h-36 rounded-full border border-[#ff5330]/20 animate-ping opacity-30" />
        <div className="absolute w-28 h-28 rounded-full border border-[#ff5330]/30 animate-pulse" />
        <div className="w-20 h-20 rounded-full border border-[#3d2a26] bg-[#140e0d]/80 flex items-center justify-center shadow-[0_0_30px_rgba(255,83,48,0.15)] backdrop-blur-md z-10">
          <div className="relative w-8 h-8 flex items-center justify-center text-[#ff5330]">
            <div className="w-2 h-2 rounded-full bg-[#ff5330] shadow-[0_0_10px_#ff5330]" />
            <div className="absolute w-5 h-5 rounded-full border border-[#ff5330]/60" />
            <div className="absolute w-full h-[1.5px] bg-[#ff5330]/80" />
            <div className="absolute h-full w-[1.5px] bg-[#ff5330]/80" />
          </div>
        </div>
      </div>
      <p className="text-xs font-mono tracking-[0.25em] text-[#8a7975] uppercase font-bold z-10">Enter a repository to start visualization</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2 z-10">
        {examples.map((u) => (
          <button key={u} onClick={() => onPick(u)} className="text-[11px] font-mono px-3 py-1.5 rounded-full border border-[#2e2a27] bg-[#141110] text-stone-400 hover:text-white hover:border-[#ff5330]/50 transition">
            {u.replace("https://github.com/", "")}
          </button>
        ))}
      </div>
    </div>
  );
}

function LoadingState({ step }: { step: number }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6">
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-[#ff5330]/20" />
        <div className="absolute inset-0 rounded-full border-2 border-[#ff5330] border-t-transparent animate-spin shadow-[0_0_25px_rgba(255,83,48,0.35)]" />
      </div>
      <div className="space-y-2 w-64">
        {LOADING_STEPS.map((s, i) => (
          <div key={s} className={`flex items-center gap-3 text-xs font-mono transition-colors duration-300 ${i < step ? "text-stone-500" : i === step ? "text-white" : "text-stone-700"}`}>
            <span className={`w-4 h-4 rounded-full border flex items-center justify-center text-[9px] ${i < step ? "border-emerald-500/60 text-emerald-400" : i === step ? "border-[#ff5330] text-[#ff5330]" : "border-stone-700"}`}>
              {i < step ? "✓" : i === step ? "•" : ""}
            </span>
            {s}
            {i === step && <span className="cl-typing ml-auto"><i /><i /><i /></span>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Analyze() {
  const navigate = useNavigate();

  // Data
  const [repoUrl, setRepoUrl] = useState("");
  const [analyzedRepo, setAnalyzedRepo] = useState("");
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [diagnosticsData, setDiagnosticsData] = useState<DiagnosticsData | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);

  // Selection / inspector
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [codeRange, setCodeRange] = useState<{ start: number; end: number } | null>(null);
  const [copied, setCopied] = useState(false);

  // View controls
  const [focusMode, setFocusMode] = useState(true);
  const [depth, setDepth] = useState(2);
  const [activeFilter, setActiveFilter] = useState<Filter>("ALL");
  const [graphType, setGraphType] = useState<View>("NODE");
  const [showApiFlow, setShowApiFlow] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Overlays
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [cycleHL, setCycleHL] = useState<Highlight | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [qnaOpen, setQnaOpen] = useState(false);
  const [qnaSeed, setQnaSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [exporting, setExporting] = useState<"png" | "pdf" | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const nodeGraphRef = useRef<GraphHandle | null>(null);
  const sunburstRef = useRef<GraphHandle | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const fileReqRef = useRef(0);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const adjacency = useMemo(() => (graphData ? buildAdjacency(graphData) : null), [graphData]);
  const highlight = impact?.highlight ?? cycleHL;

  // ------------------------------------------------------------ filtering
  const filtered = useMemo(() => {
    if (!graphData) return null;
    if (activeFilter === "ALL" || !diagnosticsData) return { data: graphData, empty: false };
    const target = new Set<string>();
    const d = diagnosticsData.diagnostics;
    if (activeFilter === "CIRCULAR") d.circularDependencies.forEach((c) => c.path.forEach((f) => target.add(f)));
    if (activeFilter === "GOD_MODULES") d.tightCouplings.forEach((c) => target.add(c.file));
    if (activeFilter === "DEAD_CODE") d.deadCode.forEach((c) => target.add(c.file));
    return {
      data: {
        nodes: graphData.nodes.filter((n) => target.has(n.id)),
        links: graphData.links.filter((l) => target.has(l.source) && target.has(l.target)),
      },
      empty: target.size === 0,
    };
  }, [graphData, diagnosticsData, activeFilter]);

  // Focus mode: neighbourhood of the selected file up to `depth` hops.
  const displayData = useMemo<GraphData | null>(() => {
    const base = filtered?.data ?? null;
    if (!base) return null;
    if (!focusMode || !selectedFile || highlight) return base;
    if (!base.nodes.some((n) => n.id === selectedFile)) return base;
    const nbrs = new Map<string, string[]>();
    for (const l of base.links) {
      (nbrs.get(l.source) || nbrs.set(l.source, []).get(l.source)!).push(l.target);
      (nbrs.get(l.target) || nbrs.set(l.target, []).get(l.target)!).push(l.source);
    }
    const seen = new Map<string, number>([[selectedFile, 0]]);
    const queue = [selectedFile];
    while (queue.length) {
      const id = queue.shift()!;
      const lvl = seen.get(id)!;
      if (lvl >= depth) continue;
      for (const n of nbrs.get(id) || []) {
        if (!seen.has(n)) {
          seen.set(n, lvl + 1);
          queue.push(n);
        }
      }
    }
    return {
      nodes: base.nodes.filter((n) => seen.has(n.id)),
      links: base.links.filter((l) => seen.has(l.source) && seen.has(l.target)),
    };
  }, [filtered, focusMode, selectedFile, depth, highlight]);

  // ------------------------------------------------------------- analysis
  const handleAnalyze = async (url: string) => {
    if (!/^https?:\/\/(www\.)?github\.com\/[^/\s]+\/[^/\s]+/i.test(url.trim())) {
      toast("error", "Paste a public GitHub repository URL, like https://github.com/owner/repo");
      return;
    }
    setLoading(true);
    setLoadingStep(0);
    const timers = [1200, 2600, 4200].map((ms, i) => window.setTimeout(() => setLoadingStep(i + 1), ms));
    try {
      const res = await fetch(`${API}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl: url.trim() }),
      });
      const raw = await res.json().catch(() => ({}));
      if (!res.ok || raw.success === false) throw new Error(raw.error || `Analysis failed (${res.status})`);

      const graph = raw.graph ?? raw;
      const formatted: GraphData = {
        nodes: (graph.nodes || []).map((n: string | { id: string; lines?: number }) => (typeof n === "string" ? { id: n } : n)),
        links: (graph.links || []).map((l: { source: string | { id: string }; target: string | { id: string } }) => ({
          source: typeof l.source === "string" ? l.source : l.source.id,
          target: typeof l.target === "string" ? l.target : l.target.id,
        })),
      };
      if (formatted.nodes.length === 0) throw new Error("No JavaScript, TypeScript or Python files were found in this repository.");

      setGraphData(formatted);
      setDiagnosticsData(raw.diagnostics ?? null);
      setEndpoints(raw.endpoints ?? []);
      setAnalyzedRepo(raw.repoUrl || url.trim());
      setRepoUrl(raw.repoUrl || url.trim());
      setSelectedFile(null);
      setFileContent(null);
      setImpact(null);
      setCycleHL(null);
      setActiveFilter("ALL");
      setShowApiFlow(false);
      toast("success", `Mapped ${formatted.nodes.length} files and ${formatted.links.length} dependencies.`);

      if (!raw.diagnostics) {
        const diagRes = await fetch(`${API}/diagnostics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formatted),
        });
        if (diagRes.ok) setDiagnosticsData(await diagRes.json());
      }
    } catch (err) {
      const msg = (err as Error).message;
      toast("error", /Failed to fetch|NetworkError/i.test(msg) ? `Can't reach the backend at ${API}. Is it running?` : msg);
    } finally {
      timers.forEach(clearTimeout);
      setLoading(false);
    }
  };

  // ------------------------------------------------------------ file view
  const openFile = useCallback(
    async (id: string, range?: { start: number; end: number } | null) => {
      setSelectedFile(id);
      setIsDiagnosticsOpen(false);
      setCodeRange(range ?? null);
      const req = ++fileReqRef.current;
      setFileLoading(true);
      try {
        const res = await fetch(`${API}/file?path=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (req !== fileReqRef.current) return;
        if (!res.ok) throw new Error(data.error || "Could not load file");
        setFileContent(data.content ?? "");
      } catch (e) {
        if (req === fileReqRef.current) {
          setFileContent(null);
          toast("error", `Couldn't open ${fileName(id)}: ${(e as Error).message}`);
        }
      } finally {
        if (req === fileReqRef.current) setFileLoading(false);
      }
    },
    [toast]
  );

  const handleNodeClick = useCallback(
    (id: string) => {
      setCycleHL(null);
      if (isDiagnosticsOpen) {
        setSelectedFile(id);
        return;
      }
      // If the code drawer is already open, follow the click with the new file.
      if (fileContent !== null) openFile(id);
      else setSelectedFile(id);
    },
    [isDiagnosticsOpen, fileContent, openFile]
  );

  // Highlight cited / requested lines in Monaco.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || fileContent == null) return;
    decorationsRef.current?.clear();
    if (codeRange) {
      ed.revealLinesInCenter(codeRange.start, codeRange.end);
      decorationsRef.current = ed.createDecorationsCollection([
        {
          range: { startLineNumber: codeRange.start, startColumn: 1, endLineNumber: codeRange.end, endColumn: 1 },
          options: { isWholeLine: true, className: "cl-code-hl", linesDecorationsClassName: "cl-code-hl-gutter" },
        },
      ]);
    } else ed.setScrollTop(0);
  }, [fileContent, codeRange]);

  const handleCite = useCallback(
    (c: Citation) => {
      openFile(c.file, { start: c.startLine, end: c.endLine });
    },
    [openFile]
  );

  // ---------------------------------------------------------- simulations
  const runImpact = useCallback(
    (id: string) => {
      if (!adjacency) return;
      setActiveFilter("ALL");
      setShowApiFlow(false);
      setCycleHL(null);
      setSelectedFile(id);
      setImpact(simulateImpact(id, adjacency, endpoints));
    },
    [adjacency, endpoints]
  );

  const showCycle = useCallback((path: string[]) => {
    setImpact(null);
    setShowApiFlow(false);
    setActiveFilter("ALL");
    setCycleHL(cycleHighlight(path));
  }, []);

  const askAbout = useCallback((text: string) => {
    setQnaOpen(true);
    setQnaSeed({ text, nonce: Date.now() });
  }, []);

  // ------------------------------------------------------------- exports
  const activeHandle = () => (graphType === "NODE" ? nodeGraphRef.current : sunburstRef.current);

  const exportAsPNG = async () => {
    setExporting("png");
    try {
      let url = !showApiFlow ? activeHandle()?.snapshot(2) ?? null : null;
      if (!url && canvasContainerRef.current) {
        const { default: html2canvas } = await import("html2canvas");
        url = (await html2canvas(canvasContainerRef.current, { backgroundColor: "#090808", scale: 2, logging: false })).toDataURL("image/png");
      }
      if (!url) throw new Error("Nothing to export yet.");
      const a = document.createElement("a");
      a.href = url;
      a.download = `CodeLens-${graphType === "NODE" ? "graph" : "sunburst"}.png`;
      a.click();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const exportPDFReport = async () => {
    if (!graphData) return;
    setExporting("pdf");
    try {
      const { exportAuditReport } = await import("../lib/auditReport");
      await exportAuditReport({
        repoUrl: analyzedRepo,
        graph: graphData,
        diagnostics: diagnosticsData,
        endpoints,
        impact,
        graphImage: nodeGraphRef.current?.snapshot(2) ?? null,
        sunburstImage: sunburstRef.current?.snapshot(1.5) ?? null,
        fallbackElement: canvasContainerRef.current,
      });
      toast("success", "Audit report downloaded.");
    } catch (e) {
      console.error(e);
      toast("error", `Report failed: ${(e as Error).message}`);
    } finally {
      setExporting(null);
    }
  };

  // ----------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA/.test((e.target as HTMLElement)?.tagName) || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (graphData) setQnaOpen((o) => !o);
      } else if (e.key === "/" && !typing && graphData) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && !typing) {
        if (menu) setMenu(null);
        else if (impact || cycleHL) {
          setImpact(null);
          setCycleHL(null);
        } else if (qnaOpen) setQnaOpen(false);
        else if (fileContent !== null) setFileContent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [graphData, menu, impact, cycleHL, qnaOpen, fileContent]);

  // ------------------------------------------------------- derived panels
  const inspector = useMemo(() => {
    if (!selectedFile || !adjacency || !graphData) return null;
    const node = graphData.nodes.find((n) => n.id === selectedFile);
    return {
      lines: node?.lines ?? 0,
      imports: adjacency.out.get(selectedFile) || [],
      importedBy: adjacency.in.get(selectedFile) || [],
      endpoints: endpoints.filter((e) => e.filePath === selectedFile),
    };
  }, [selectedFile, adjacency, graphData, endpoints]);

  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !graphData) return [];
    return graphData.nodes.filter((n) => n.id.toLowerCase().includes(q)).slice(0, 8);
  }, [search, graphData]);

  const rightPanelOpen = isDiagnosticsOpen || (!!selectedFile && !!inspector);

  const chip = (active: boolean) =>
    `px-2.5 py-1 rounded-md transition border text-[11px] ${active ? "bg-[#ff5330]/20 text-[#ff5330] border-[#ff5330]" : "bg-[#181514] text-stone-400 border-[#2b2523] hover:text-white"}`;
  const viewBtn = (active: boolean) =>
    `px-3 py-1 rounded-md transition border ${active ? "bg-[#ff5330] text-white border-[#ff5330]" : "bg-[#1d1918] text-stone-400 border-[#2e2a27] hover:text-white"}`;

  return (
    <div className="bg-[#090808] text-white h-screen flex flex-col font-sans overflow-hidden">
      <Navbar
        repoUrl={repoUrl}
        setRepoUrl={setRepoUrl}
        onAnalyze={handleAnalyze}
        loading={loading}
        focusOn={focusMode}
        setFocusOn={setFocusMode}
        depth={depth}
        setDepth={setDepth}
        issueCount={diagnosticsData?.summary?.totalIssues || 0}
        isDiagnosticsOpen={isDiagnosticsOpen}
        setIsDiagnosticsOpen={(open) => {
          setIsDiagnosticsOpen(open);
          if (open) setFileContent(null);
        }}
        onBackHome={() => navigate("/")}
      />

      {/* Control bar */}
      {graphData && (
        <div className="bg-[#12100f] border-b border-[#2e2a27] px-4 lg:px-6 py-2 flex items-center justify-between gap-3 text-xs font-mono z-10 shrink-0 overflow-x-auto cl-scroll-x">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-stone-500">VIEW</span>
            <div className="flex items-center rounded-lg p-0.5 bg-[#1a1716] border border-[#2e2a27] relative">
              <button onClick={() => { setGraphType("NODE"); setShowApiFlow(false); }} className={`${viewBtn(graphType === "NODE" && !showApiFlow)} border-0`}>Node Graph</button>
              <button onClick={() => { setGraphType("SUNBURST"); setShowApiFlow(false); }} className={`${viewBtn(graphType === "SUNBURST" && !showApiFlow)} border-0`}>Circular Sunburst</button>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-stone-500 mr-1">FILTER</span>
            {([
              { id: "ALL", label: "ALL" },
              { id: "CIRCULAR", label: `CIRCULAR ${diagnosticsData?.summary.circularCount ?? 0}` },
              { id: "GOD_MODULES", label: `GOD MODULES ${diagnosticsData?.summary.tightCouplingCount ?? 0}` },
              { id: "DEAD_CODE", label: `DEAD CODE ${diagnosticsData?.summary.deadCodeCount ?? 0}` },
            ] as { id: Filter; label: string }[]).map((b) => (
              <button key={b.id} onClick={() => { setActiveFilter(b.id); setImpact(null); setCycleHL(null); setShowApiFlow(false); }} className={chip(activeFilter === b.id)}>
                {b.label}
              </button>
            ))}
          </div>

          <div className="relative shrink-0">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchMatches[0]) {
                  openFile(searchMatches[0].id);
                  setSearch("");
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") { setSearch(""); e.currentTarget.blur(); }
              }}
              placeholder="Search files  /"
              className="w-44 focus:w-60 transition-all bg-[#181514] border border-[#2b2523] focus:border-[#ff5330]/60 rounded-md px-2.5 py-1 text-[11px] text-stone-200 placeholder:text-stone-600 outline-none"
            />
            {searchMatches.length > 0 && (
              <div className="absolute right-0 mt-1 w-72 rounded-lg border border-[#2e2a27] bg-[#141110]/95 backdrop-blur-xl shadow-2xl p-1 z-50">
                {searchMatches.map((n) => (
                  <button key={n.id} onMouseDown={(e) => { e.preventDefault(); openFile(n.id); setSearch(""); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-[#ff5330]/15 text-[11px] text-stone-300 truncate">
                    <span className="text-white">{fileName(n.id)}</span> <span className="text-stone-500">{n.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { setShowApiFlow((s) => !s); setImpact(null); setCycleHL(null); }}
              className={`px-3 py-1 rounded-md transition border text-[11px] font-bold ${showApiFlow ? "bg-[#ff5330] text-white border-[#ff5330]" : "bg-[#2b1f1c] text-[#ff8c6b] border-[#3d2c28] hover:text-white hover:border-[#ff5330]/40"}`}
            >
              {showApiFlow ? "✕ API Flow" : `API Flow ${endpoints.length ? endpoints.length : ""}`}
            </button>
            <button
              onClick={() => setQnaOpen((o) => !o)}
              className={`px-3 py-1 rounded-md transition border text-[11px] font-bold flex items-center gap-1.5 ${qnaOpen ? "bg-[#ff5330] text-white border-[#ff5330]" : "bg-[#1e1a19] text-stone-200 border-[#3d2c28] hover:border-[#ff5330]/50 cl-glow-btn"}`}
              title="Ask AI (Ctrl/Cmd + K)"
            >
              ✦ Ask AI <kbd className="text-[9px] opacity-60 font-normal">⌘K</kbd>
            </button>
            <button onClick={exportAsPNG} disabled={!!exporting} className="px-3 py-1 bg-[#1e1a19] hover:bg-[#2a2422] border border-[#362e2b] rounded-md text-stone-300 transition text-[11px] disabled:opacity-50">
              {exporting === "png" ? "Exporting…" : "📸 PNG"}
            </button>
            <button onClick={exportPDFReport} disabled={!!exporting} className="px-3 py-1 bg-[#2b1f1c] hover:bg-[#3d2c28] border border-[#ff5330]/40 text-[#ff5330] rounded-md transition font-bold text-[11px] disabled:opacity-50 flex items-center gap-1.5">
              {exporting === "pdf" && <span className="w-3 h-3 border-2 border-[#ff5330] border-t-transparent rounded-full animate-spin" />}
              {exporting === "pdf" ? "Building report…" : "📄 Export Audit Report"}
            </button>
          </div>
        </div>
      )}

      {/* Workspace */}
      <div className="flex-1 flex relative overflow-hidden">
        <div ref={canvasContainerRef} className="flex-1 flex flex-col relative bg-[#090808] min-w-0">
          {loading ? (
            <LoadingState step={loadingStep} />
          ) : graphData ? (
            <>
              <div className={`absolute inset-0 ${showApiFlow ? "invisible" : ""}`}>
                <div className={`absolute inset-0 transition-opacity duration-300 ${graphType === "NODE" ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                  <ForceGraph
                    ref={nodeGraphRef}
                    data={displayData}
                    selectedFile={selectedFile}
                    highlight={highlight}
                    search={search}
                    active={graphType === "NODE" && !showApiFlow}
                    onNodeClick={handleNodeClick}
                    onNodeContextMenu={(id, x, y) => setMenu({ id, x, y })}
                    onBackgroundClick={() => { setCycleHL(null); }}
                  />
                </div>
                <div className={`absolute inset-0 transition-opacity duration-300 ${graphType === "SUNBURST" ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                  <SunburstGraph
                    ref={sunburstRef}
                    data={displayData}
                    selectedFile={selectedFile}
                    highlight={highlight}
                    search={search}
                    active={graphType === "SUNBURST" && !showApiFlow}
                    onNodeClick={handleNodeClick}
                    onNodeContextMenu={(id, x, y) => setMenu({ id, x, y })}
                    onBackgroundClick={() => { setCycleHL(null); }}
                  />
                </div>

                {filtered?.empty && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-center bg-[#121110]/90 border border-[#2e2a27] rounded-xl px-6 py-4">
                      <div className="text-emerald-400 text-sm font-semibold">Nothing to show here</div>
                      <div className="text-[11px] font-mono text-stone-500 mt-1">No files match the {activeFilter.replace("_", " ").toLowerCase()} filter.</div>
                    </div>
                  </div>
                )}

                {/* Graph toolbar */}
                <div className="absolute top-4 left-4 z-10 flex flex-col gap-1.5">
                  <button onClick={() => activeHandle()?.zoomToFit()} className="w-8 h-8 rounded-lg bg-[#141110]/85 border border-[#2e2a27] text-stone-400 hover:text-white hover:border-[#ff5330]/50 text-sm backdrop-blur-md" title="Fit to screen">⤢</button>
                  {(selectedFile || highlight) && (
                    <button onClick={() => { setSelectedFile(null); setImpact(null); setCycleHL(null); setFileContent(null); }} className="w-8 h-8 rounded-lg bg-[#141110]/85 border border-[#2e2a27] text-stone-400 hover:text-white hover:border-[#ff5330]/50 text-xs backdrop-blur-md" title="Clear selection">✕</button>
                  )}
                </div>
                {!highlight && !selectedFile && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 text-[10px] font-mono text-stone-500 bg-[#121110]/70 border border-[#2a2422] rounded-full px-3 py-1 backdrop-blur-md pointer-events-none cl-fade-up">
                    Click a file to inspect · right-click to simulate a change · scroll to zoom
                  </div>
                )}
                {cycleHL && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 text-[11px] font-mono text-red-300 bg-red-950/60 border border-red-500/40 rounded-full px-4 py-1.5 backdrop-blur-md flex items-center gap-3">
                    Showing circular dependency ({cycleHL.ids.size} files)
                    <button onClick={() => setCycleHL(null)} className="text-red-200 hover:text-white">✕</button>
                  </div>
                )}
                {impact && <ImpactPanel impact={impact} onClose={() => setImpact(null)} onSelect={(id) => openFile(id)} />}
              </div>

              {showApiFlow && (
                <div className="absolute inset-0 z-10">
                  <ApiFlowPanel
                    apiBase={API}
                    repoUrl={analyzedRepo}
                    onInspectFile={(filePath: string) => {
                      setShowApiFlow(false);
                      openFile(filePath);
                    }}
                  />
                </div>
              )}

              {!showApiFlow && (
                <div className="absolute bottom-4 left-4 z-10">
                  <RepoHealthPanel diagnostics={diagnosticsData} graph={graphData} />
                </div>
              )}
            </>
          ) : (
            <EmptyState
              onPick={(u) => {
                setRepoUrl(u);
                handleAnalyze(u);
              }}
            />
          )}

          {/* Monaco code drawer */}
          {!isDiagnosticsOpen && selectedFile && (fileContent !== null || fileLoading) && (
            <div className="absolute bottom-0 right-4 left-4 bg-[#141212] border border-[#2a2222] rounded-t-xl overflow-hidden z-30 shadow-2xl h-[42%] min-h-[220px] flex flex-col cl-slide-up">
              <div className="flex items-center justify-between px-4 py-2 bg-[#1c1818] border-b border-[#2a2222]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-[#ff5330] shrink-0" />
                  <span className="text-xs font-mono text-stone-300 font-semibold truncate">{selectedFile}</span>
                  {codeRange && <span className="text-[10px] font-mono text-[#ff8c6b] bg-[#ff5330]/10 border border-[#ff5330]/30 rounded px-1.5">L{codeRange.start}–{codeRange.end}</span>}
                </div>
                <button onClick={() => { setFileContent(null); setFileLoading(false); fileReqRef.current++; }} className="text-xs text-stone-400 hover:text-white px-2 py-1 bg-[#282020] rounded font-mono">✕</button>
              </div>
              <div className="flex-1 relative">
                {fileLoading || fileContent === null ? (
                  <div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-stone-500">Loading source…</div>
                ) : (
                  <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-stone-500">Loading editor…</div>}>
                    <Editor
                      height="100%"
                      language={langFor(selectedFile)}
                      path={selectedFile}
                      value={fileContent}
                      theme="vs-dark"
                      onMount={(ed) => {
                        editorRef.current = ed;
                        if (codeRange) {
                          ed.revealLinesInCenter(codeRange.start, codeRange.end);
                          decorationsRef.current = ed.createDecorationsCollection([
                            {
                              range: { startLineNumber: codeRange.start, startColumn: 1, endLineNumber: codeRange.end, endColumn: 1 },
                              options: { isWholeLine: true, className: "cl-code-hl", linesDecorationsClassName: "cl-code-hl-gutter" },
                            },
                          ]);
                        }
                      }}
                      options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, smoothScrolling: true, renderLineHighlight: "none" }}
                    />
                  </Suspense>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right panel */}
        {rightPanelOpen && (
          <div className="w-[360px] shrink-0 h-full border-l border-[#2e2a27] bg-[#0d0c0c] z-20 shadow-2xl overflow-y-auto cl-scroll cl-slide-in">
            {isDiagnosticsOpen ? (
              <DiagnosticsPanel
                data={diagnosticsData}
                selectedFile={selectedFile}
                onSelectFile={(f) => setSelectedFile(f)}
                onHighlightCycle={showCycle}
                onSimulate={runImpact}
              />
            ) : (
              selectedFile &&
              inspector && (
                <div className="p-5 flex flex-col gap-5">
                  <div className="flex items-center justify-between border-b border-[#221e1c] pb-3">
                    <h3 className="text-sm font-semibold text-stone-200 tracking-wide font-mono">File Inspector</h3>
                    <button onClick={() => { setSelectedFile(null); setFileContent(null); }} className="text-stone-500 hover:text-stone-300 text-xs px-2 py-1 bg-[#1a1716] rounded border border-[#2d2624]">✕</button>
                  </div>

                  <div>
                    <span className="text-[10px] font-mono tracking-widest text-[#ff5330] uppercase block mb-1 font-bold">File</span>
                    <p className="text-xs font-mono text-stone-300 break-all bg-[#171413] p-2.5 rounded-lg border border-[#2a2422] mb-3">{selectedFile}</p>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {[
                        { k: "Lines", v: inspector.lines },
                        { k: "Imports", v: inspector.imports.length },
                        { k: "Used by", v: inspector.importedBy.length },
                      ].map((s) => (
                        <div key={s.k} className="rounded-lg bg-[#151211] border border-[#2a2422] py-2 text-center">
                          <div className="text-sm font-bold text-white tabular-nums">{s.v}</div>
                          <div className="text-[9px] font-mono uppercase tracking-wider text-stone-500">{s.k}</div>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => openFile(selectedFile)} className="py-1.5 px-3 bg-[#1e1b19] border border-[#332c29] text-stone-200 hover:border-[#ff5330]/50 text-xs rounded-lg transition font-mono">{"</>"} Source</button>
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(selectedFile).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          });
                        }}
                        className="py-1.5 px-3 bg-[#1e1b19] border border-[#332c29] text-stone-300 hover:border-[#ff5330]/50 text-xs rounded-lg transition font-mono"
                      >
                        {copied ? "Copied ✓" : "Copy path"}
                      </button>
                      <button
                        onClick={() => window.open(`${analyzedRepo.replace(/\.git$/, "")}/blob/HEAD/${selectedFile}`, "_blank", "noopener")}
                        className="py-1.5 px-3 bg-[#1e1b19] border border-[#332c29] text-stone-300 hover:border-[#ff5330]/50 text-xs rounded-lg transition font-mono"
                      >
                        GitHub ↗
                      </button>
                      <button onClick={() => askAbout(`What does ${selectedFile} do, and how is it used by the rest of the codebase?`)} className="py-1.5 px-3 bg-[#1e1b19] border border-[#332c29] text-stone-300 hover:border-[#ff5330]/50 text-xs rounded-lg transition font-mono">✦ Ask AI</button>
                    </div>
                    <button onClick={() => runImpact(selectedFile)} className="mt-2 w-full py-2 px-3 bg-[#ff5330]/15 border border-[#ff5330]/50 text-[#ff8c6b] hover:bg-[#ff5330]/25 hover:text-white text-xs rounded-lg transition font-mono font-bold">
                      ⚡ Simulate Change Impact
                    </button>
                  </div>

                  {inspector.endpoints.length > 0 && (
                    <FileList title="Endpoints" items={inspector.endpoints.map((e) => `${e.method} ${e.path}`)} />
                  )}
                  <FileList title="Imports" items={inspector.imports} onPick={(f) => setSelectedFile(f)} />
                  <FileList title="Imported by" items={inspector.importedBy} onPick={(f) => setSelectedFile(f)} />
                </div>
              )
            )}
          </div>
        )}

        <QnAPanel open={qnaOpen} apiBase={API} repoUrl={analyzedRepo} onClose={() => setQnaOpen(false)} onCite={handleCite} seed={qnaSeed} />
      </div>

      <NodeContextMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onSimulate={runImpact}
        onOpen={(id) => openFile(id)}
        onFocus={(id) => {
          setImpact(null);
          setCycleHL(null);
          setFocusMode(true);
          setSelectedFile(id);
        }}
        onAsk={(id) => askAbout(`Explain what ${id} does and which other parts of the codebase depend on it.`)}
      />

      {/* Toasts */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[70] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`cl-fade-up pointer-events-auto text-xs font-mono px-4 py-2.5 rounded-xl border backdrop-blur-xl shadow-2xl max-w-[90vw] ${
              t.kind === "error" ? "bg-red-950/80 border-red-500/40 text-red-200" : t.kind === "success" ? "bg-[#141110]/90 border-emerald-500/30 text-emerald-200" : "bg-[#141110]/90 border-[#2e2a27] text-stone-200"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function FileList({ title, items, onPick }: { title: string; items: string[]; onPick?: (f: string) => void }) {
  return (
    <div>
      <div className="text-[10px] font-mono tracking-widest text-stone-500 uppercase mb-1.5">
        {title} <span className="text-stone-600">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] font-mono text-stone-600">None</div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto cl-scroll">
          {items.map((f) =>
            onPick ? (
              <button key={f} onClick={() => onPick(f)} className="w-full text-left text-[11px] font-mono text-stone-400 hover:text-white hover:bg-[#1a1615] px-2 py-1 rounded truncate" title={f}>
                {f}
              </button>
            ) : (
              <div key={f} className="text-[11px] font-mono text-stone-400 px-2 py-1 truncate">{f}</div>
            )
          )}
        </div>
      )}
    </div>
  );
}
