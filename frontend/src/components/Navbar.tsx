import type { FormEvent } from "react";

type Props = {
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  onAnalyze: (url: string) => void;
  loading?: boolean;
  focusOn: boolean;
  setFocusOn: (v: boolean) => void;
  depth: number;
  setDepth: (v: number) => void;
  issueCount: number;
  isDiagnosticsOpen: boolean;
  setIsDiagnosticsOpen: (v: boolean) => void;
  onBackHome: () => void;
};

export default function Navbar({
  repoUrl,
  setRepoUrl,
  onAnalyze,
  loading = false,
  focusOn,
  setFocusOn,
  depth,
  setDepth,
  issueCount,
  isDiagnosticsOpen,
  setIsDiagnosticsOpen,
  onBackHome,
}: Props) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (repoUrl.trim() && !loading) onAnalyze(repoUrl.trim());
  };

  return (
    <header className="w-full bg-[#ebdcc9] px-4 lg:px-6 py-3 flex items-center justify-between gap-4 text-black font-sans border-b border-[#d8c7b4] shadow-md select-none z-30 h-16 shrink-0">
      <div className="flex items-center gap-4 min-w-0">
        <button
          onClick={onBackHome}
          className="flex items-center gap-1 cursor-pointer font-extrabold text-2xl tracking-tight hover:opacity-80 transition-opacity shrink-0"
          aria-label="CodeLens home"
        >
          <span className="text-black font-black">Code</span>
          <span className="text-[#ff4d2e] font-black">Lens</span>
        </button>

        <form onSubmit={handleSubmit} className="flex items-center gap-2.5 min-w-0">
          <div className="w-[min(22rem,32vw)] min-w-[12rem] relative">
            <input
              type="url"
              inputMode="url"
              spellCheck={false}
              placeholder="https://github.com/owner/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              className="w-full bg-white rounded-full py-2.5 pl-5 pr-4 text-sm font-mono font-bold text-gray-900 placeholder-gray-400 outline-none shadow-inner border-2 border-stone-300 focus:border-[#ff4d2e] transition"
              aria-label="GitHub repository URL"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !repoUrl.trim()}
            className="px-6 py-2.5 rounded-full bg-[#ff5330] hover:bg-[#e04322] text-white text-sm font-black shadow-md transition uppercase tracking-wider shrink-0 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && <span className="w-3.5 h-3.5 border-2 border-white/80 border-t-transparent rounded-full animate-spin" />}
            {loading ? "Analyzing" : "Analyze"}
          </button>
        </form>
      </div>

      <div className="flex items-center gap-3 text-sm font-mono shrink-0">
        <button
          onClick={() => setFocusOn(!focusOn)}
          title="When on, selecting a file shows only its neighbourhood up to the chosen depth"
          className={`px-4 py-2 rounded-full border-2 border-black font-black text-xs transition-all shadow-sm ${
            focusOn ? "bg-black text-white" : "bg-transparent text-black hover:bg-black/5"
          }`}
        >
          Focus {focusOn ? "ON" : "OFF"}
        </button>

        <label className={`hidden xl:flex items-center gap-3 px-4 py-1.5 bg-[#dfcfbd]/70 rounded-full border border-black/20 shadow-sm ${focusOn ? "" : "opacity-50"}`}>
          <span className="text-stone-900 font-extrabold text-xs uppercase tracking-wide">Depth</span>
          <input
            type="range"
            min={1}
            max={5}
            value={depth}
            disabled={!focusOn}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="w-20 h-1.5 bg-stone-500 rounded-lg appearance-none cursor-pointer accent-[#ff5330] disabled:cursor-not-allowed"
          />
          <span className="text-black font-black text-sm min-w-[12px] text-center">{depth}</span>
        </label>

        <button
          onClick={() => setIsDiagnosticsOpen(!isDiagnosticsOpen)}
          className={`flex items-center rounded-full border-2 border-black overflow-hidden font-black transition shadow-sm hover:-translate-y-px ${
            isDiagnosticsOpen ? "ring-2 ring-[#ff3b30] ring-offset-1 ring-offset-[#ebdcc9]" : ""
          }`}
        >
          <span className="px-4 py-2 bg-transparent text-black text-xs font-black">Diagnostics</span>
          <span className="bg-[#ff3b30] text-white px-3 py-2 text-xs uppercase font-black border-l-2 border-black tabular-nums">
            {issueCount} {issueCount === 1 ? "issue" : "issues"}
          </span>
        </button>

        <button
          onClick={onBackHome}
          className="hidden lg:block px-4 py-2 rounded-full border-2 border-black/30 text-stone-900 hover:border-black hover:bg-black/5 transition font-mono text-xs font-black"
        >
          ← back home
        </button>
      </div>
    </header>
  );
}
