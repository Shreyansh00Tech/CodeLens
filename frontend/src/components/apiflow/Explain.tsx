import { memo, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, Code2, Info, Pause, Play, X } from "lucide-react";
import type { AnalysisNote, FlowNode, FlowTrace } from "../../lib/types";
import type { Evidence, Seg, Sentence, WalkStep } from "../../lib/flowExplain";
import { PHASE_LABEL } from "../../lib/flowExplain";
import { nodeColor } from "./flowTheme";

const MONO = "font-mono";

export type FileLoader = (path: string) => Promise<string[]>;
export type OpenRange = (file: string, start: number, end: number) => void;

// ------------------------------------------------------------------ sentences

export function Segs({ segs, nodeById, onGo }: { segs: Seg[]; nodeById: Map<string, FlowNode>; onGo: (id: string) => void }) {
  return (
    <>
      {segs.map((s, i) =>
        typeof s === "string" ? (
          <span key={i}>{renderTicks(s)}</span>
        ) : (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); onGo(s.id); }}
            className={`inline align-baseline ${MONO} text-[10.5px] px-1 rounded border border-transparent hover:border-[#ff5330]/40 transition break-all`}
            style={{ color: nodeColor(nodeById.get(s.id)), background: `${nodeColor(nodeById.get(s.id))}14` }}
            title="Show in graph"
          >
            {s.label}
          </button>
        ),
      )}
    </>
  );
}

/** `code` spans inside explanation text */
function renderTicks(s: string) {
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") ? <code key={i} className={`${MONO} text-[10.5px] text-[#ffd9bc] bg-[#1f1a19] border border-[#2e2a27] rounded px-1`}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>));
}

const BASIS_LABEL: Record<string, { text: string; title: string }> = {
  name: { text: "inferred from name", title: "This statement is a hint based on a function, package or middleware name, not on its code." },
  convention: { text: "convention", title: "Based on HTTP / framework conventions rather than this project's code." },
};

export function SentenceList({ items, nodeById, onGo, bullets = false }: { items: Sentence[]; nodeById: Map<string, FlowNode>; onGo: (id: string) => void; bullets?: boolean }) {
  return (
    <ul className={`space-y-1.5 ${bullets ? "" : ""}`}>
      {items.map((s, i) => (
        <li key={i} className="text-[11.5px] leading-relaxed text-stone-300 flex gap-2" style={{ paddingLeft: (s.depth || 0) * 12 }}>
          {bullets && <span className="mt-[7px] w-1 h-1 rounded-full shrink-0" style={{ background: s.conditional ? "#f5b347" : "#5b4a44" }} />}
          <span className="min-w-0">
            <Segs segs={s.segs} nodeById={nodeById} onGo={onGo} />
            {s.conditional && bullets && <span className={`ml-1 text-[9px] ${MONO} uppercase tracking-wider text-amber-400/80`}>conditional</span>}
            {s.basis && BASIS_LABEL[s.basis] && (
              <span className={`ml-1.5 text-[9px] ${MONO} uppercase tracking-wider text-stone-500 border border-[#2e2a27] rounded px-1 cursor-help`} title={BASIS_LABEL[s.basis].title}>{BASIS_LABEL[s.basis].text}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ source preview

type PreviewState = { file: string; status: "ready" | "error"; lines: string[]; error?: string };

/**
 * Inline, read-only view of the exact lines behind a node or connection.
 * `range` is shaded (the definition), `focus` lines are highlighted (the call).
 */
export const CodePreview = memo(function CodePreview({ file, range, focus, loadFile, onOpen, maxLines = 26 }: {
  file: string; range: [number, number]; focus: number[]; loadFile: FileLoader; onOpen: OpenRange; maxLines?: number;
}) {
  const [loaded, setLoaded] = useState<PreviewState | null>(null);
  useEffect(() => {
    let live = true;
    loadFile(file)
      .then((lines) => { if (live) setLoaded({ file, status: "ready", lines }); })
      .catch((e: Error) => { if (live) setLoaded({ file, status: "error", lines: [], error: e.message }); });
    return () => { live = false; };
  }, [file, loadFile]);
  const st = loaded && loaded.file === file ? loaded : { file, status: "loading" as const, lines: [] as string[], error: undefined };

  const [start, end] = range;
  const window = useMemo(() => {
    const total = st.lines.length;
    if (!total) return null;
    const anchor = focus.length ? Math.min(...focus) : start;
    let a = Math.max(1, start - 1);
    let b = Math.min(total, end + 1);
    if (b - a + 1 > maxLines) {
      // Long definition: show its first lines and the focused call site
      a = Math.max(1, Math.min(anchor, start) - 2);
      b = Math.min(total, a + maxLines - 1);
      if (anchor > b - 2) { a = Math.max(1, anchor - Math.floor(maxLines / 2)); b = Math.min(total, a + maxLines - 1); }
    }
    return { a, b };
  }, [st.lines.length, start, end, focus, maxLines]);

  return (
    <div className="rounded-lg border border-[#2e2a27] bg-[#0c0a09] overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[#2e2a27] bg-[#121110]">
        <Code2 size={11} className="text-[#ff5330] shrink-0" />
        <span className={`text-[10px] ${MONO} text-stone-400 truncate`} title={file}>{file}</span>
        <span className={`text-[9.5px] ${MONO} text-[#ff8c6b] bg-[#ff5330]/10 border border-[#ff5330]/30 rounded px-1 shrink-0`}>L{start}{end > start ? `–${end}` : ""}</span>
        <button onClick={() => onOpen(file, start, end)} className={`ml-auto shrink-0 text-[10px] ${MONO} text-stone-400 hover:text-white`} title="Open the full file in the code viewer with these lines highlighted">Open in editor ↗</button>
      </div>
      {st.status === "loading" && <div className={`px-3 py-3 text-[10px] ${MONO} text-stone-600`}>Loading source…</div>}
      {st.status === "error" && <div className={`px-3 py-3 text-[10px] ${MONO} text-red-300/80`}>Could not load source: {st.error}</div>}
      {st.status === "ready" && window && (
        <pre className={`text-[10.5px] leading-[1.55] ${MONO} overflow-x-auto py-1`}>
          {st.lines.slice(window.a - 1, window.b).map((l, i) => {
            const ln = window.a + i;
            const inRange = ln >= start && ln <= end;
            const isFocus = focus.includes(ln);
            return (
              <div key={ln} className={`flex ${isFocus ? "bg-[#ff5330]/18" : inRange ? "bg-[#ff5330]/[0.06]" : ""}`} style={{ boxShadow: isFocus ? "inset 2px 0 0 #ff5330" : inRange ? "inset 2px 0 0 #ff533055" : undefined }}>
                <span className="w-9 shrink-0 text-right pr-2 text-stone-600 select-none">{ln}</span>
                <span className={`pr-3 whitespace-pre ${isFocus ? "text-white" : inRange ? "text-stone-300" : "text-stone-500"}`}>{l || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
});

export function EvidenceList({ items, onOpen }: { items: Evidence[]; onOpen: OpenRange }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((ev, i) => (
        <li key={i}>
          <button onClick={() => onOpen(ev.file, ev.line, ev.line)} className="w-full text-left group rounded-md border border-[#2a2422] bg-[#141110] hover:border-[#ff5330]/40 px-2.5 py-1.5 transition">
            <div className={`flex items-center gap-2 text-[9.5px] ${MONO} text-stone-500`}>
              <span className="uppercase tracking-wider">{ev.label}</span>
              <span className="ml-auto text-stone-400 group-hover:text-[#ff8c6b] truncate">{ev.file}:{ev.line}</span>
            </div>
            {ev.text && <code className={`block mt-0.5 text-[10.5px] ${MONO} text-[#ffd9bc] truncate`} title={ev.text}>{ev.text}</code>}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ notes

export function NotesPanel({ notes, onGo, analysis, nodeById }: { notes: AnalysisNote[]; onGo: (id: string) => void; analysis?: FlowTrace["analysis"]; nodeById: Map<string, FlowNode> }) {
  const warn = notes.filter((n) => n.severity === "warn");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!notes.length) return null;
  const tone = warn.length ? "border-amber-500/25 bg-[#1b1510]/90 text-amber-200/90" : "border-[#2a2222]/70 bg-[#121110]/90 text-stone-300";
  return (
    <div className={`pointer-events-auto rounded-lg border backdrop-blur-md text-[10.5px] shadow-xl ${tone}`}>
      <button onClick={() => setOpen((o) => !o)} className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 ${MONO} text-left`} aria-expanded={open}>
        {warn.length ? <AlertTriangle size={12} className="shrink-0 text-amber-400" /> : <Info size={12} className="shrink-0 text-stone-400" />}
        <span className="truncate">{warn.length ? `Partial trace · ${notes.length} analysis note${notes.length > 1 ? "s" : ""}` : `${notes.length} analysis note${notes.length > 1 ? "s" : ""}`}</span>
        {open ? <ChevronDown size={12} className="ml-auto shrink-0" /> : <ChevronRight size={12} className="ml-auto shrink-0" />}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1 max-h-[46vh] overflow-y-auto">
          {analysis && <p className="px-1 pb-1 text-[10.5px] text-stone-400 leading-snug">{analysis.description}</p>}
          {notes.map((n) => {
            const isOpen = expanded === n.id;
            return (
              <div key={n.id} className="rounded-md border border-[#2a2422] bg-[#0f0d0c]/80">
                <button onClick={() => setExpanded(isOpen ? null : n.id)} className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${n.severity === "warn" ? "bg-amber-400" : "bg-stone-500"}`} />
                  <span className={`${MONO} text-[10.5px] ${n.severity === "warn" ? "text-amber-100" : "text-stone-200"}`}>{n.title}</span>
                  {isOpen ? <ChevronDown size={11} className="ml-auto shrink-0 text-stone-500" /> : <ChevronRight size={11} className="ml-auto shrink-0 text-stone-500" />}
                </button>
                {isOpen && (
                  <div className="px-2.5 pb-2 text-[11px] leading-relaxed text-stone-300 space-y-1.5">
                    <p>{n.detail}</p>
                    {n.hint && <p className="text-stone-500"><span className={`${MONO} text-[9.5px] uppercase tracking-wider text-stone-500 mr-1`}>What to do</span>{n.hint}</p>}
                    {n.nodeIds && n.nodeIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {n.nodeIds.slice(0, 8).map((id) => (
                          <button key={id} onClick={() => onGo(id)} className={`${MONO} text-[10px] px-1.5 py-0.5 rounded border border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40`} style={{ color: nodeColor(nodeById.get(id)) }} title="Show in graph">{nodeById.get(id)?.name || "node"}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ walkthrough

const PHASE_ORDER = ["request", "middleware", "handler", "logic", "data", "external", "response", "error"] as const;

export function WalkthroughView({ steps, selectedId, nodeById, onSelect, onGo, onPlay }: {
  steps: WalkStep[]; selectedId: string | null; nodeById: Map<string, FlowNode>; onSelect: (id: string) => void; onGo: (id: string) => void; onPlay: (index: number) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of steps) c[s.phase] = (c[s.phase] || 0) + 1;
    return c;
  }, [steps]);
  return (
    <div className="absolute inset-0 overflow-y-auto pt-24 pb-10 px-4 md:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center gap-1.5 mb-5">
          {PHASE_ORDER.filter((p) => counts[p]).map((p, i, arr) => (
            <div key={p} className="flex items-center gap-1.5">
              <span className={`text-[10px] ${MONO} px-2 py-1 rounded-md border border-[#2e2a27] bg-[#121110] text-stone-300`}>{PHASE_LABEL[p]} <span className="text-stone-600">{counts[p]}</span></span>
              {i < arr.length - 1 && <ChevronRight size={11} className="text-stone-600" />}
            </div>
          ))}
          <button onClick={() => onPlay(0)} className={`ml-auto text-[11px] ${MONO} px-2.5 py-1 rounded-md bg-[#ff5330] text-white hover:bg-[#ff6a4a] inline-flex items-center gap-1.5`}><Play size={11} /> Walk through on graph</button>
        </div>
        <ol className="relative border-l border-[#2a2422] ml-3">
          {steps.map((s, i) => {
            const prevPhase = i ? steps[i - 1].phase : null;
            const color = nodeColor(s.node);
            return (
              <li key={s.node.id} className="relative">
                {s.phase !== prevPhase && (
                  <div className={`-ml-3 mt-4 mb-1.5 pl-6 text-[9px] ${MONO} uppercase tracking-widest text-stone-500`}>{PHASE_LABEL[s.phase]}</div>
                )}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(s.node.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") onSelect(s.node.id); }}
                  className={`ml-4 my-0.5 rounded-lg px-3 py-2 border transition cursor-pointer ${selectedId === s.node.id ? "bg-[#1f1816] border-[#ff5330]/50" : "border-transparent hover:bg-[#151211] hover:border-[#2a2222]"}`}
                  style={{ marginLeft: 16 + s.depth * 18 }}
                >
                  <span className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full border-2 border-[#090808]" style={{ background: color }} />
                  <div className="flex items-baseline gap-2">
                    <span className={`shrink-0 text-[10px] ${MONO} text-stone-600 w-5 text-right`}>{i + 1}</span>
                    <span className="text-[11.5px] leading-relaxed text-stone-300 min-w-0">
                      <Segs segs={s.sentence} nodeById={nodeById} onGo={onGo} />
                      {s.edge?.conditional && <span className={`ml-1.5 text-[9px] ${MONO} uppercase tracking-wider text-amber-400/80`}>only on some paths</span>}
                    </span>
                  </div>
                  <div className={`ml-7 text-[10px] ${MONO} text-stone-500 truncate`}>
                    {s.edge?.file && s.edge.lines.length ? `${s.edge.file}:${s.edge.lines[0]}` : `${s.node.filePath}${s.node.line ? `:${s.node.line}` : ""}`}
                    {s.edge?.snippet ? <span className="text-stone-600">  ·  {s.edge.snippet}</span> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-6 text-[10.5px] text-stone-600 leading-relaxed">
          Static analysis: this is every step the code makes possible, in call order. A real request follows only the branches its data selects (steps marked “only on some paths” may be skipped).
        </p>
      </div>
    </div>
  );
}

/** Floating stepper shown over the graph while walking through the flow. */
export function WalkthroughBar({ steps, index, nodeById, playing, onIndex, onTogglePlay, onClose, onGo }: {
  steps: WalkStep[]; index: number; nodeById: Map<string, FlowNode>; playing: boolean; onIndex: (i: number) => void; onTogglePlay: () => void; onClose: () => void; onGo: (id: string) => void;
}) {
  const s = steps[index];
  if (!s) return null;
  const btn = "w-7 h-7 inline-flex items-center justify-center rounded-md bg-[#1d1918] text-stone-300 border border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40 transition disabled:opacity-30";
  return (
    <div className="absolute bottom-3 left-3 z-20 w-[min(620px,calc(100%-24px))] sm:w-[min(620px,calc(100%-210px))] rounded-xl border border-[#3d2a26] bg-[#121110]/95 backdrop-blur-md shadow-2xl px-3 py-2.5" role="region" aria-label="Flow walkthrough">
      <div className="flex items-center gap-2">
        <span className={`text-[9px] ${MONO} uppercase tracking-widest px-1.5 py-0.5 rounded border`} style={{ color: nodeColor(s.node), borderColor: `${nodeColor(s.node)}55` }}>{PHASE_LABEL[s.phase]}</span>
        <span className={`text-[10px] ${MONO} text-stone-500`}>Step {index + 1} / {steps.length}</span>
        <div className="ml-auto flex items-center gap-1">
          <button className={btn} onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous step"><ChevronLeft size={14} /></button>
          <button className={btn} onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
          <button className={btn} onClick={() => onIndex(index + 1)} disabled={index >= steps.length - 1} aria-label="Next step"><ChevronRight size={14} /></button>
          <button className={btn} onClick={onClose} aria-label="Exit walkthrough"><X size={13} /></button>
        </div>
      </div>
      <div className="mt-1.5 text-[12px] leading-relaxed text-stone-200">
        <Segs segs={s.sentence} nodeById={nodeById} onGo={onGo} />
        {s.edge?.conditional && <span className={`ml-1.5 text-[9px] ${MONO} uppercase tracking-wider text-amber-400/80`}>only on some paths</span>}
      </div>
      {s.edge?.snippet && <code className={`block mt-1 text-[10.5px] ${MONO} text-[#ffd9bc] truncate`} title={s.edge.snippet}>{s.edge.file}:{s.edge.lines[0]}  {s.edge.snippet}</code>}
      <div className="mt-2 h-0.5 rounded bg-[#2a2422] overflow-hidden"><div className="h-full bg-[#ff5330] transition-[width] duration-300" style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
    </div>
  );
}
