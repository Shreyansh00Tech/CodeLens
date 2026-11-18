import { Activity, ShieldCheck, Zap } from "lucide-react";
import type { DiagnosticsData } from "../lib/types";

type Props = {
  data: DiagnosticsData | null;
  selectedFile: string | null;
  onSelectFile: (file: string) => void;
  onHighlightCycle: (path: string[]) => void;
  onSimulate: (file: string) => void;
};

export default function DiagnosticsPanel({ data, selectedFile, onSelectFile, onHighlightCycle, onSimulate }: Props) {
  if (!data) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="w-6 h-6 border-2 border-[#ff5330] border-t-transparent rounded-full animate-spin" />
        <p className="text-xs font-mono text-stone-500">Run an analysis to see diagnostics.</p>
      </div>
    );
  }

  const { healthScore, summary, diagnostics: details } = data;
  const rowBase = "w-full text-left bg-[#1a1816] border p-2.5 rounded-lg transition-colors group";

  return (
    <div className="w-full bg-[#121110] text-amber-50/90 min-h-full flex flex-col gap-6 p-4 select-none">
      <h2 className="text-sm font-semibold tracking-wider text-amber-100 uppercase flex items-center gap-2">
        <Activity className="w-4 h-4 text-orange-500" /> Diagnostics
      </h2>

      {/* Circular dependencies */}
      <section>
        <div className="text-xs font-bold text-red-400 tracking-wider mb-2">CIRCULAR DEPENDENCIES ({summary.circularCount})</div>
        <div className="space-y-2">
          {details.circularDependencies.length > 0 ? (
            details.circularDependencies.map((cycle, idx) => (
              <button key={cycle.id || idx} className={`${rowBase} border-red-900/40 hover:border-red-500 flex items-center justify-between gap-2`} onClick={() => onHighlightCycle(cycle.path)}>
                <span className="text-[11px] text-amber-200/80 font-mono truncate" title={cycle.formatted}>{cycle.formatted}</span>
                <span className="text-[10px] font-bold bg-red-950 text-red-300 px-2 py-1 rounded group-hover:bg-red-800 transition shrink-0">VIEW</span>
              </button>
            ))
          ) : (
            <p className="text-xs text-emerald-500/80 flex items-center gap-1 font-mono"><ShieldCheck className="w-3.5 h-3.5" /> No cycles detected</p>
          )}
        </div>
      </section>

      {/* Tight coupling */}
      <section>
        <div className="text-xs font-bold text-orange-400 tracking-wider mb-2">TIGHT COUPLING ({summary.tightCouplingCount} god files)</div>
        <div className="space-y-2">
          {details.tightCouplings.length > 0 ? (
            details.tightCouplings
              .slice()
              .sort((a, b) => b.score - a.score)
              .map((item) => (
                <div key={item.file} className={`${rowBase} ${selectedFile === item.file ? "border-orange-500" : "border-orange-900/40 hover:border-orange-500"}`}>
                  <button className="w-full text-left" onClick={() => onSelectFile(item.file)}>
                    <div className="text-xs text-amber-100 font-mono truncate" title={item.file}>{item.file}</div>
                    <div className="text-[10px] text-orange-400/80 font-mono mt-1">
                      Fan-in {item.fanIn} · Fan-out {item.fanOut} · Score {item.score} · <span className={item.severity === "CRITICAL" ? "text-red-400" : ""}>{item.severity}</span>
                    </div>
                  </button>
                  <button onClick={() => onSimulate(item.file)} className="mt-2 text-[10px] font-mono text-[#ff8c6b] hover:text-white flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Simulate change impact
                  </button>
                </div>
              ))
          ) : (
            <p className="text-xs text-emerald-500/80 flex items-center gap-1 font-mono"><ShieldCheck className="w-3.5 h-3.5" /> Coupling density optimal</p>
          )}
        </div>
      </section>

      {/* Dead code */}
      <section>
        <div className="text-xs font-bold text-amber-400 tracking-wider mb-2">DEAD / ORPHAN CODE ({summary.deadCodeCount})</div>
        <div className="space-y-2">
          {details.deadCode.length > 0 ? (
            details.deadCode
              .slice()
              .sort((a, b) => b.lines - a.lines)
              .map((item) => (
                <button
                  key={item.file}
                  className={`${rowBase} ${selectedFile === item.file ? "border-amber-500" : "border-amber-900/30 hover:border-amber-500"} flex items-center justify-between gap-2`}
                  onClick={() => onSelectFile(item.file)}
                >
                  <span className="min-w-0">
                    <span className="block text-xs text-amber-100 font-mono truncate" title={item.file}>{item.file}</span>
                    <span className="block text-[10px] text-amber-500/70 font-mono">0 importers · {item.lines} lines</span>
                  </span>
                  <span className="text-[10px] font-bold text-amber-500 group-hover:text-amber-300 tracking-wider shrink-0">INSPECT</span>
                </button>
              ))
          ) : (
            <p className="text-xs text-emerald-500/80 flex items-center gap-1 font-mono"><ShieldCheck className="w-3.5 h-3.5" /> No orphaned modules</p>
          )}
        </div>
      </section>

      {/* Health card */}
      <div className="bg-[#181614] border border-[#2e2a27] p-4 rounded-lg mt-auto">
        <h3 className="text-xs font-bold text-amber-200 uppercase tracking-widest mb-3">Repo health</h3>
        <div className="flex items-center gap-4">
          <div className="relative w-16 h-16 flex items-center justify-center">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
              <path className="text-stone-800" strokeWidth="3.5" stroke="currentColor" fill="none" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              <path
                className={healthScore > 80 ? "text-emerald-500" : healthScore > 50 ? "text-orange-500" : "text-red-500"}
                strokeDasharray={`${healthScore}, 100`}
                strokeWidth="3.5"
                strokeLinecap="round"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
            <span className="absolute text-sm font-bold text-amber-100 font-mono">{healthScore}%</span>
          </div>
          <div className="flex-1">
            <div className="text-[11px] text-amber-200/70">HEALTH SCORE</div>
            <div className="text-xs font-semibold text-amber-100 mt-1">
              {healthScore >= 80 ? "Good modularity" : healthScore >= 50 ? "Needs attention" : "Critical refactor"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
