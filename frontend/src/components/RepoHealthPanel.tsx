import { useMemo, useState } from "react";
import type { DiagnosticsData, GraphData } from "../lib/types";

/** Bottom-left health widget. All numbers come from the analysed graph. */

function sparkPath(values: number[], w = 200, h = 30) {
  if (values.length === 0) return `M 0 ${h} L ${w} ${h}`;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`)
    .join(" ");
}

function bucket(values: number[], n = 24) {
  if (values.length <= n) return values;
  const size = values.length / n;
  return Array.from({ length: n }, (_, i) => {
    const slice = values.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    return slice.reduce((s, v) => s + v, 0) / (slice.length || 1);
  });
}

export default function RepoHealthPanel({ diagnostics, graph }: { diagnostics: DiagnosticsData | null; graph: GraphData | null }) {
  const [collapsed, setCollapsed] = useState(false);
  const score = diagnostics?.healthScore ?? 0;

  const metrics = useMemo(() => {
    if (!graph) return null;
    const fanIn = new Map<string, number>();
    for (const l of graph.links) fanIn.set(l.target, (fanIn.get(l.target) || 0) + 1);
    const fanInDist = graph.nodes.map((n) => fanIn.get(n.id) || 0).sort((a, b) => b - a);
    const coupled = fanInDist.filter((v) => v >= 3).length;
    const dead = (diagnostics?.diagnostics.deadCode || []).map((d) => d.lines).sort((a, b) => b - a);
    const deadLines = dead.reduce((s, v) => s + v, 0);
    return {
      coupled,
      fanInPath: sparkPath(bucket(fanInDist)),
      deadLines,
      deadPath: sparkPath(bucket(dead.length ? dead : [0])),
    };
  }, [graph, diagnostics]);

  const radius = 40;
  const circumference = Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const tone = score >= 80 ? "Healthy" : score >= 50 ? "Needs attention" : "At risk";

  return (
    <div className={`bg-[#141212]/80 backdrop-blur-md border border-[#2a2222] rounded-2xl text-white shadow-2xl relative overflow-hidden transition-all duration-300 ${collapsed ? "w-[210px] p-3" : "w-[440px] p-4"}`}>
      <div className="absolute -top-10 -left-10 w-32 h-32 bg-[#ff4d4d]/10 rounded-full blur-2xl pointer-events-none" />

      <div className={`flex items-center justify-between ${collapsed ? "" : "mb-3 border-b border-[#2a2121] pb-2"}`}>
        <h3 className="text-xs tracking-wider uppercase font-bold text-[#a09090] flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#ff4d4d] animate-pulse" />
          Repo Health
          {collapsed && <span className="text-white tabular-nums ml-1">{score}%</span>}
        </h3>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="text-[#887878] hover:text-white transition-colors text-lg font-light leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-white/5"
          aria-label={collapsed ? "Expand health panel" : "Collapse health panel"}
        >
          {collapsed ? "+" : "−"}
        </button>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-3 gap-3 items-center">
          <div className="flex flex-col items-center justify-center border-r border-[#2a2121] pr-2">
            <span className="text-[10px] tracking-wider text-[#887878] uppercase font-semibold mb-1">Health Score</span>
            <div className="relative w-24 h-14 flex items-end justify-center">
              <svg className="w-24 h-14 overflow-visible" viewBox="0 0 104 56">
                <defs>
                  <linearGradient id="healthGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#ff4d4d" />
                    <stop offset="100%" stopColor="#ff8c3b" />
                  </linearGradient>
                </defs>
                <path d="M 12 50 A 40 40 0 0 1 92 50" fill="none" stroke="#2a2121" strokeWidth={7} strokeLinecap="round" />
                <path
                  d="M 12 50 A 40 40 0 0 1 92 50"
                  fill="none"
                  stroke="url(#healthGradient)"
                  strokeWidth={7}
                  strokeDasharray={circumference}
                  strokeDashoffset={offset}
                  strokeLinecap="round"
                  style={{ transition: "stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1)" }}
                />
              </svg>
              <div className="absolute bottom-0 text-center">
                <span className="text-xl font-extrabold tracking-tight text-white tabular-nums">{diagnostics ? `${score}%` : "–"}</span>
              </div>
            </div>
            <span className="text-[9px] font-mono text-stone-500 mt-1">{diagnostics ? tone : "computing…"}</span>
          </div>

          <div className="flex flex-col justify-between h-full pl-1">
            <span className="text-[10px] tracking-wider text-[#a09090] font-medium truncate">Modules Coupled</span>
            <span className="text-sm font-bold tabular-nums">{metrics?.coupled ?? 0}<span className="text-[9px] text-stone-500 font-mono ml-1">fan-in ≥ 3</span></span>
            <div className="w-full h-8 mt-1">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 200 30" preserveAspectRatio="none">
                <path d={metrics?.fanInPath || ""} fill="none" stroke="#ff6b4a" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
          </div>

          <div className="flex flex-col justify-between h-full pl-1">
            <span className="text-[10px] tracking-wider text-[#a09090] font-medium truncate">Lines of Unused Code</span>
            <span className="text-sm font-bold tabular-nums">{(metrics?.deadLines ?? 0).toLocaleString()}</span>
            <div className="w-full h-8 mt-1">
              <svg className="w-full h-full overflow-visible" viewBox="0 0 200 30" preserveAspectRatio="none">
                <path d={metrics?.deadPath || ""} fill="none" stroke="#d96b43" strokeWidth="2" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
