import { useEffect, useMemo, useRef, useState } from "react";
import { fileName, fuzzyScore } from "../lib/graphAnalysis";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  /** Extra words that should also match this action. */
  keywords?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  files: string[];
  actions: PaletteAction[];
  /** Currently selected file, used to offer file-specific actions first. */
  onPickFile: (id: string) => void;
  onClose: () => void;
};

type Row =
  | { kind: "action"; key: string; action: PaletteAction; score: number }
  | { kind: "file"; key: string; id: string; score: number };

const MAX_FILES = 40;

/**
 * Cmd/Ctrl+K launcher: fuzzy-jump to any file or run an action. Pure overlay –
 * it does not touch the layout underneath and every animation is
 * opacity/transform only.
 */
export default function CommandPalette({ open, ...rest }: Props) {
  // Mounted only while open, so query/cursor start fresh every time without reset effects.
  return open ? <PaletteBody {...rest} /> : null;
}

function PaletteBody({ files, actions, onPickFile, onClose }: Omit<Props, "open">) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const out: Row[] = [];
    for (const a of actions) {
      if (!q) {
        out.push({ kind: "action", key: `a:${a.id}`, action: a, score: 1000 });
        continue;
      }
      // Commands match on whole words (not scattered letters), so "router" never surfaces "Turn focus mode off".
      const hay = `${a.label} ${a.keywords ?? ""}`.toLowerCase();
      const tokens = q.toLowerCase().split(/\s+/);
      if (tokens.every((t) => hay.includes(t))) out.push({ kind: "action", key: `a:${a.id}`, action: a, score: 60 + (a.label.toLowerCase().startsWith(tokens[0]) ? 40 : 0) });
    }
    if (q) {
      const scored: Row[] = [];
      for (const id of files) {
        const s = fuzzyScore(q, id);
        if (s >= 0) scored.push({ kind: "file", key: `f:${id}`, id, score: s });
      }
      scored.sort((a, b) => b.score - a.score);
      out.push(...scored.slice(0, MAX_FILES));
    }
    return out.sort((a, b) => b.score - a.score);
  }, [query, files, actions]);

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === "action") row.action.run();
    else onPickFile(row.id);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[14vh] px-4 cl-palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="cl-palette w-full max-w-xl rounded-2xl border border-[#3a312d] bg-[#110e0d]/95 shadow-[0_30px_80px_rgba(0,0,0,0.7)] overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => (rows.length ? (c + 1) % rows.length : 0));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(rows[cursor]);
          }
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#2a2321]">
          <span className="text-[#ff5330] text-sm">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            placeholder="Jump to a file or run a command…"
            className="flex-1 bg-transparent outline-none text-sm font-mono text-stone-100 placeholder:text-stone-600"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="text-[10px] font-mono text-stone-500 border border-[#2e2a27] rounded px-1.5 py-0.5">esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto cl-scroll p-1.5">
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs font-mono text-stone-500">No file or command matches “{query}”.</div>
          ) : (
            rows.map((row, i) => {
              const active = i === cursor;
              return (
                <button
                  key={row.key}
                  data-i={i}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => choose(row)}
                  className={`w-full flex items-center gap-3 text-left px-3 py-2 rounded-lg transition-colors ${active ? "bg-[#ff5330]/15" : ""}`}
                >
                  {row.kind === "action" ? (
                    <>
                      <span className={`w-6 text-center text-sm ${active ? "text-[#ff5330]" : "text-stone-500"}`}>{row.action.icon}</span>
                      <span className="flex-1 text-[13px] text-stone-200">{row.action.label}</span>
                      {row.action.hint && <span className="text-[10px] font-mono text-stone-500">{row.action.hint}</span>}
                    </>
                  ) : (
                    <>
                      <span className={`w-6 text-center text-xs font-mono ${active ? "text-[#ff5330]" : "text-stone-600"}`}>{"</>"}</span>
                      <span className="text-[13px] text-white font-mono">{fileName(row.id)}</span>
                      <span className="flex-1 text-[11px] text-stone-500 font-mono truncate" dir="rtl">
                        <bdi>{row.id}</bdi>
                      </span>
                    </>
                  )}
                  {active && <span className="text-[10px] font-mono text-stone-500">↵</span>}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-[#2a2321] text-[10px] font-mono text-stone-600">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span className="ml-auto">{files.length} files indexed</span>
        </div>
      </div>
    </div>
  );
}
