import { useEffect, useRef, useState } from "react";
import type { ImpactResult } from "../lib/types";
import { fileName } from "../lib/graphAnalysis";

/* ------------------------------------------------------------------ */
/* Right-click context menu                                            */
/* ------------------------------------------------------------------ */

export type MenuState = { id: string; x: number; y: number } | null;

export function NodeContextMenu({
  menu,
  onClose,
  onSimulate,
  onOpen,
  onFocus,
  onAsk,
}: {
  menu: MenuState;
  onClose: () => void;
  onSimulate: (id: string) => void;
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
  onAsk: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("wheel", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  const left = Math.min(menu.x, window.innerWidth - 250);
  const top = Math.min(menu.y, window.innerHeight - 220);
  const item = "w-full text-left px-3 py-2 rounded-md text-xs font-mono text-stone-300 hover:bg-[#ff5330]/15 hover:text-white flex items-center gap-2.5 transition-colors";

  return (
    <div
      ref={ref}
      className="fixed z-[60] w-[240px] rounded-xl border border-[#2e2a27] bg-[#141110]/95 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.6)] p-1.5 cl-pop"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 pt-1.5 pb-2 border-b border-[#2a2422] mb-1">
        <div className="text-[9px] uppercase tracking-widest text-stone-500 font-mono">File</div>
        <div className="text-xs font-mono text-white truncate" title={menu.id}>{fileName(menu.id)}</div>
      </div>
      <button className={`${item} text-[#ff8c6b]`} onClick={() => { onSimulate(menu.id); onClose(); }}>
        <span className="w-4 text-center">⚡</span> Simulate Change Impact
      </button>
      <button className={item} onClick={() => { onOpen(menu.id); onClose(); }}>
        <span className="w-4 text-center">{"</>"}</span> Open source
      </button>
      <button className={item} onClick={() => { onFocus(menu.id); onClose(); }}>
        <span className="w-4 text-center">◎</span> Focus neighbourhood
      </button>
      <button className={item} onClick={() => { onAsk(menu.id); onClose(); }}>
        <span className="w-4 text-center">✦</span> Ask AI about this file
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Impact summary overlay                                              */
/* ------------------------------------------------------------------ */

const RISK_STYLE: Record<ImpactResult["riskLabel"], string> = {
  LOW: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  MEDIUM: "text-amber-300 border-amber-400/40 bg-amber-400/10",
  HIGH: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  CRITICAL: "text-red-400 border-red-500/50 bg-red-500/10",
};

export function ImpactPanel({
  impact,
  onClose,
  onSelect,
}: {
  impact: ImpactResult;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<"files" | "tests" | "apis">("files");
  const nonSource = impact.affected.filter((a) => a.depth > 0);
  const headline =
    impact.files === 0
      ? "Nothing else imports this file. Changing it is isolated."
      : `${impact.apis.length} API${impact.apis.length === 1 ? "" : "s"} and ${impact.tests.length} test file${impact.tests.length === 1 ? "" : "s"} could break`;

  return (
    <div className="absolute top-4 right-4 z-20 w-[340px] max-h-[calc(100%-2rem)] flex flex-col rounded-2xl border border-[#3d2a26] bg-[#120e0d]/90 backdrop-blur-xl shadow-[0_24px_70px_rgba(0,0,0,0.55)] cl-slide-in overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b border-[#2a2120]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[9px] font-mono uppercase tracking-[0.2em] text-[#ff5330] mb-1">What-if · change impact</div>
            <div className="text-sm font-semibold text-white font-mono truncate" title={impact.source}>{fileName(impact.source)}</div>
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-white text-xs px-2 py-1 rounded border border-[#2d2624] bg-[#1a1716]" aria-label="Clear impact simulation">✕</button>
        </div>
        <p className="mt-3 text-[13px] leading-snug text-stone-200">{headline}</p>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {[
            { k: "Files", v: impact.files },
            { k: "APIs", v: impact.apis.length },
            { k: "Tests", v: impact.tests.length },
            { k: "Depth", v: impact.maxDepth },
          ].map((s) => (
            <div key={s.k} className="rounded-lg bg-[#1a1514] border border-[#2a2120] px-2 py-1.5 text-center">
              <div className="text-base font-bold text-white tabular-nums">{s.v}</div>
              <div className="text-[9px] font-mono uppercase tracking-wider text-stone-500">{s.k}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className={`text-[10px] font-mono font-bold px-2 py-1 rounded border ${RISK_STYLE[impact.riskLabel]}`}>
            RISK {impact.riskScore}/100 · {impact.riskLabel}
          </span>
          <div className="flex items-center gap-2 text-[9px] font-mono text-stone-500">
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-[#ff5330] inline-block" />1 hop</span>
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-[#ff8a4c] inline-block" />2</span>
            <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-[#ffb547] inline-block" />3+</span>
          </div>
        </div>
      </div>

      <div className="flex gap-1 px-3 pt-2">
        {(["files", "tests", "apis"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 text-[10px] font-mono uppercase tracking-wider py-1.5 rounded-md border transition ${
              tab === t ? "bg-[#ff5330]/15 text-[#ff8c6b] border-[#ff5330]/40" : "text-stone-500 border-transparent hover:text-stone-300"
            }`}
          >
            {t === "files" ? `Files (${nonSource.length})` : t === "tests" ? `Tests (${impact.tests.length})` : `APIs (${impact.apis.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 cl-scroll">
        {tab === "files" &&
          (nonSource.length ? (
            nonSource.map((a) => (
              <button key={a.id} onClick={() => onSelect(a.id)} className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#1f1918] group">
                <span className="text-[9px] font-mono w-6 shrink-0 text-center rounded bg-[#241c1a] text-stone-400">{a.depth}</span>
                <span className="text-[11px] font-mono text-stone-300 truncate group-hover:text-white" title={a.id}>{a.id}</span>
                {a.isTest && <span className="ml-auto text-[8px] font-mono text-teal-300 border border-teal-400/30 rounded px-1">TEST</span>}
              </button>
            ))
          ) : (
            <Empty text="No dependents found." />
          ))}
        {tab === "tests" &&
          (impact.tests.length ? (
            impact.tests.map((t) => (
              <button key={t} onClick={() => onSelect(t)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[#1f1918] text-[11px] font-mono text-teal-200/90 truncate" title={t}>
                {t}
              </button>
            ))
          ) : (
            <Empty text="No test files depend on this change. Consider adding coverage before editing." />
          ))}
        {tab === "apis" &&
          (impact.apis.length ? (
            impact.apis.map((ep, i) => (
              <button key={`${ep.method}-${ep.path}-${i}`} onClick={() => onSelect(ep.filePath)} className="w-full text-left px-2 py-1.5 rounded-md hover:bg-[#1f1918]">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-[#ff5330]/15 text-[#ff8c6b]">{ep.method}</span>
                  <span className="text-[11px] font-mono text-stone-200 truncate">{ep.path}</span>
                </div>
                <div className="text-[9px] font-mono text-stone-500 truncate mt-0.5">{ep.filePath}:{ep.startLine}</div>
              </button>
            ))
          ) : (
            <Empty text="No HTTP endpoints sit on the affected path." />
          ))}
      </div>
      <div className="px-4 py-2 border-t border-[#2a2120] text-[9px] font-mono text-stone-500">
        Reverse-transitive closure over imports · test scope = regression suite to run
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-[11px] font-mono text-stone-500 px-2 py-3">{text}</div>;
}
