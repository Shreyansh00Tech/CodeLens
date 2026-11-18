import type { StartHereItem } from "../lib/graphAnalysis";
import { fileName } from "../lib/graphAnalysis";

type Props = {
  items: StartHereItem[];
  /** Index of the file currently being toured, or null when browsing the list. */
  step: number | null;
  onOpen: (id: string, index: number) => void;
  onStartTour: () => void;
  onStep: (delta: number) => void;
  onClose: () => void;
};

const ROLE_STYLE: Record<StartHereItem["role"], string> = {
  "Entry point": "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  "API surface": "text-sky-300 border-sky-500/30 bg-sky-500/10",
  Hub: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  "Core module": "text-[#ff8c6b] border-[#ff5330]/30 bg-[#ff5330]/10",
};

/**
 * Onboarding card: the few files worth reading first, ranked by PageRank
 * centrality, plus a step-by-step tour that opens each one in the code drawer.
 */
export default function StartHerePanel({ items, step, onOpen, onStartTour, onStep, onClose }: Props) {
  const touring = step !== null;
  return (
    <div className="absolute top-4 right-4 z-20 w-[320px] max-h-[calc(100%-2rem-var(--cl-drawer,0px))] flex flex-col rounded-2xl border border-[#3a312d] bg-[#110e0d]/95 backdrop-blur-xl shadow-2xl cl-slide-in overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2321]">
        <div>
          <div className="text-[10px] font-mono tracking-widest text-[#ff5330] uppercase font-bold">Start here</div>
          <div className="text-[11px] text-stone-500 mt-0.5">{touring ? `Stop ${step + 1} of ${items.length}` : "Read these first, in this order"}</div>
        </div>
        <button onClick={onClose} className="text-xs text-stone-500 hover:text-white px-2 py-1 bg-[#1a1716] rounded border border-[#2d2624]" aria-label="Close">✕</button>
      </div>

      {items.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs font-mono text-stone-500">Not enough connected source files to suggest a reading order.</div>
      ) : (
        <div className="overflow-y-auto cl-scroll p-2 space-y-1">
          {items.map((it, i) => (
            <button
              key={it.id}
              onClick={() => onOpen(it.id, i)}
              className={`cl-start-row w-full text-left rounded-xl px-3 py-2.5 border transition-colors ${
                step === i ? "border-[#ff5330]/60 bg-[#ff5330]/10" : "border-transparent hover:bg-[#1a1514]"
              }`}
              style={{ ["--i" as string]: i }}
            >
              <div className="flex items-center gap-2">
                <span className={`w-5 h-5 shrink-0 rounded-full text-[10px] font-mono font-bold flex items-center justify-center ${step === i ? "bg-[#ff5330] text-white" : "bg-[#221c1a] text-stone-400"}`}>{i + 1}</span>
                <span className="text-[13px] text-white font-mono truncate" title={it.id}>{fileName(it.id)}</span>
                <span className={`ml-auto shrink-0 text-[9px] font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${ROLE_STYLE[it.role]}`}>{it.role}</span>
              </div>
              <div className="mt-1.5 pl-7">
                <div className="text-[11px] text-stone-500 truncate" title={it.id}>{it.id}</div>
                <div className="text-[11px] text-stone-400 mt-0.5">{it.reason}</div>
                <div className="mt-1.5 h-[3px] rounded-full bg-[#221c1a] overflow-hidden">
                  <div className="h-full w-full origin-left rounded-full bg-gradient-to-r from-[#ff5330] to-[#ff8c6b] cl-start-bar" style={{ transform: `scaleX(${it.score / 100})` }} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div className="p-3 border-t border-[#2a2321] flex items-center gap-2">
          {touring ? (
            <>
              <button onClick={() => onStep(-1)} disabled={step === 0} className="px-3 py-1.5 rounded-lg text-xs font-mono border border-[#332c29] bg-[#1e1b19] text-stone-300 disabled:opacity-40 hover:border-[#ff5330]/50">← Prev</button>
              <button onClick={() => onStep(1)} className="flex-1 px-3 py-1.5 rounded-lg text-xs font-mono font-bold bg-[#ff5330] text-white hover:bg-[#ff6a4a]">
                {step + 1 >= items.length ? "Finish tour ✓" : "Next →"}
              </button>
            </>
          ) : (
            <button onClick={onStartTour} className="w-full px-3 py-2 rounded-lg text-xs font-mono font-bold bg-[#ff5330]/15 border border-[#ff5330]/50 text-[#ff8c6b] hover:bg-[#ff5330]/25 hover:text-white transition">
              ▶ Start guided tour
            </button>
          )}
        </div>
      )}
    </div>
  );
}
