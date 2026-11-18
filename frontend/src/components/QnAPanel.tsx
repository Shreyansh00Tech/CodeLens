import { useCallback, useEffect, useRef, useState } from "react";
import Markdown, { type Citation } from "./Markdown";

/**
 * Glassmorphic RAG chat drawer. Streams answers from POST /ask (SSE) and
 * renders citations as clickable file/line badges.
 */

type Source = Citation & { symbols?: string[]; score: number; kind: "retrieved" | "graph"; via: string | null };

type Message =
  | { id: number; role: "user"; text: string }
  | {
      id: number;
      role: "assistant";
      text: string;
      sources: Source[];
      status: "streaming" | "done" | "error";
      mode?: "llm" | "offline";
      error?: string;
      analysis?: { intents: string[]; sections: string[]; endpoint: string | null } | null;
    };

type IndexStatus = { ready: boolean; building: boolean; chunks: number; llm: boolean; model: string; unreachable?: boolean } | null;

type Props = {
  open: boolean;
  apiBase: string;
  repoUrl: string;
  onClose: () => void;
  onCite: (c: Citation) => void;
  /** Pre-filled question, e.g. from the node context menu. Change `nonce` to resend. */
  seed?: { text: string; nonce: number } | null;
};

const SUGGESTIONS = [
  "Explain the overall architecture of this project.",
  "Where does the application start?",
  "Which files are responsible for authentication?",
  "Which files handle API routes and how are they wired?",
];

const INTENT_LABEL: Record<string, string> = {
  architecture: "project structure", entry: "entry points", endpoint: "API flow trace", impact: "impact analysis",
  relationship: "import graph", locate: "file search",
};

let nextId = 1;

export default function QnAPanel({ open, apiBase, repoUrl, onClose, onCite, seed }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<IndexStatus>(null);
  const [openSources, setOpenSources] = useState<Record<number, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickRef = useRef(true);

  // Reset the conversation when a different repository is analysed.
  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setStatus(null);
  }, [repoUrl]);

  // Poll index status while the drawer is open and the index is building.
  useEffect(() => {
    if (!open || !repoUrl) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`${apiBase}/ask/status`);
        if (!res.ok) throw new Error(String(res.status));
        const s = (await res.json()) as IndexStatus;
        if (!alive) return;
        setStatus(s);
        if (s && !s.ready) timer = window.setTimeout(tick, 1200);
      } catch {
        if (!alive) return;
        setStatus({ ready: false, building: false, chunks: 0, llm: false, model: "", unreachable: true });
        timer = window.setTimeout(tick, 3000);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [open, apiBase, repoUrl]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 250);
  }, [open]);

  // Auto-scroll while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patchAssistant = (id: number, fn: (m: Extract<Message, { role: "assistant" }>) => Partial<Extract<Message, { role: "assistant" }>>) =>
    setMessages((prev) => prev.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...fn(m) } : m)));

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy || !status?.ready) return;
      // Prior completed turns give the backend context for follow-up questions.
      const history = messages
        .filter((m) => m.role === "user" || (m.role === "assistant" && m.status === "done" && m.text))
        .slice(-12)
        .map((m) => ({ role: m.role, text: m.text }));
      setInput("");
      stickRef.current = true;
      const userMsg: Message = { id: nextId++, role: "user", text: q };
      const aId = nextId++;
      setMessages((prev) => [...prev, userMsg, { id: aId, role: "assistant", text: "", sources: [], status: "streaming" }]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`${apiBase}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ question: q, stream: true, history }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
          throw new Error(err.error || `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let evt: { type: string; citations?: Source[]; text?: string; mode?: "llm" | "offline"; error?: string; analysis?: Extract<Message, { role: "assistant" }>["analysis"] };
            try {
              evt = JSON.parse(line.slice(6));
            } catch {
              continue; // ignore a malformed event rather than killing the stream
            }
            if (evt.type === "sources") patchAssistant(aId, () => ({ sources: evt.citations || [], analysis: evt.analysis || null }));
            else if (evt.type === "delta") patchAssistant(aId, (m) => ({ text: m.text + (evt.text || "") }));
            else if (evt.type === "done") patchAssistant(aId, () => ({ status: "done", mode: evt.mode }));
            else if (evt.type === "error") patchAssistant(aId, () => ({ status: "error", error: evt.error }));
          }
        }
        patchAssistant(aId, (m) => ({ status: m.status === "streaming" ? "done" : m.status }));
      } catch (e) {
        const aborted = (e as Error).name === "AbortError";
        patchAssistant(aId, (m) => ({
          status: aborted ? "done" : "error",
          text: aborted && m.text ? m.text + "\n\n_(stopped)_" : m.text,
          error: aborted ? undefined : (e as Error).message || "Network error. Is the backend running?",
        }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [apiBase, busy, messages, status?.ready]
  );

  // Handle seeded questions from elsewhere in the UI.
  const lastSeed = useRef<number | null>(null);
  useEffect(() => {
    if (open && seed && seed.nonce !== lastSeed.current && status?.ready) {
      lastSeed.current = seed.nonce;
      ask(seed.text);
    }
  }, [open, seed, status?.ready, ask]);

  const statusPill = !repoUrl
    ? { dot: "bg-stone-500", text: "No repository" }
    : status?.unreachable
      ? { dot: "bg-red-400", text: "Backend unreachable" }
    : !status
      ? { dot: "bg-stone-500 animate-pulse", text: "Connecting…" }
      : status.building || !status.ready
        ? { dot: "bg-amber-400 animate-pulse", text: "Indexing code…" }
        : { dot: status.llm ? "bg-emerald-400" : "bg-amber-400", text: `${status.chunks} chunks · ${status.llm ? "Claude" : "static analysis only (no AI key)"}` };

  return (
    <aside
      className={`absolute top-0 right-0 h-full w-[460px] max-w-full z-40 flex flex-col border-l border-[#2e2a27] bg-[#090808]/80 backdrop-blur-2xl shadow-[-30px_0_80px_rgba(0,0,0,0.55)] transition-transform duration-300 ease-[cubic-bezier(.2,.8,.2,1)] ${
        open ? "translate-x-0" : "translate-x-full pointer-events-none"
      }`}
      aria-hidden={!open}
    >
      {/* Header */}
      <div className="shrink-0 px-5 py-4 border-b border-[#2e2a27] flex items-center justify-between bg-gradient-to-b from-[#ff5330]/[0.07] to-transparent">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-[#ff5330]/15 border border-[#ff5330]/30 flex items-center justify-center text-[#ff5330] text-sm">✦</span>
            <h2 className="text-sm font-semibold text-white tracking-wide">Ask the codebase</h2>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-mono text-stone-400">
            <span className={`w-1.5 h-1.5 rounded-full ${statusPill.dot}`} />
            {statusPill.text}
            <span className="text-stone-600 truncate" title={status?.llm ? `Model: ${status.model}` : undefined}>· code search + analysis</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {messages.length > 0 && (
            <button onClick={() => { abortRef.current?.abort(); setMessages([]); }} className="text-[10px] font-mono px-2.5 py-1.5 rounded-md text-stone-400 hover:text-white border border-[#2e2a27] bg-[#151211]">
              Clear
            </button>
          )}
          <button onClick={onClose} className="text-xs px-2.5 py-1.5 rounded-md text-stone-400 hover:text-white border border-[#2e2a27] bg-[#151211]" aria-label="Close chat">
            ✕
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-5 cl-scroll"
      >
        {messages.length === 0 && (
          <div className="pt-6">
            <div className="text-[22px] font-semibold leading-tight text-white">
              Questions in, <span className="text-[#ff5330]">cited answers</span> out.
            </div>
            <p className="mt-2 text-xs text-stone-400 leading-relaxed">
              Answers are grounded in the indexed repository. Every claim links to the exact file and lines it came from.
            </p>
            <div className="mt-5 space-y-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  disabled={!status?.ready || busy}
                  onClick={() => ask(s)}
                  className="w-full text-left text-xs text-stone-300 px-3.5 py-2.5 rounded-xl border border-[#2e2a27] bg-[#141110]/70 hover:border-[#ff5330]/50 hover:text-white hover:bg-[#1b1615] transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end cl-fade-up">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#ff5330] text-white text-[13px] px-4 py-2.5 shadow-[0_8px_24px_rgba(255,83,48,0.25)] whitespace-pre-wrap break-words">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="cl-fade-up">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="w-5 h-5 rounded-md bg-[#1d1716] border border-[#3d2a26] text-[#ff5330] text-[10px] flex items-center justify-center">✦</span>
                <span className="text-[10px] font-mono uppercase tracking-widest text-stone-500">CodeLens</span>
                {m.mode === "offline" && <span className="text-[9px] font-mono text-amber-300/80 border border-amber-400/30 rounded px-1" title="No AI key on the server: the answer is assembled from static analysis and code search only">static analysis only</span>}
                {m.mode === "llm" && <span className="text-[9px] font-mono text-emerald-300/80 border border-emerald-400/30 rounded px-1" title="Written by Claude from the cited evidence">AI · cited</span>}
              </div>
              {m.analysis && m.analysis.intents.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {m.analysis.intents.map((i) => (
                    <span key={i} className="text-[9px] font-mono text-stone-400 bg-[#1a1514] border border-[#2e2a27] rounded px-1.5 py-0.5" title="CodeLens analysis used as evidence for this answer">
                      ⌁ {INTENT_LABEL[i] || i}{i === "endpoint" && m.analysis?.endpoint ? `: ${m.analysis.endpoint}` : ""}
                    </span>
                  ))}
                </div>
              )}
              <div className="rounded-2xl rounded-tl-md border border-[#2e2a27] bg-[#131010]/80 px-4 py-3 text-[13px] text-stone-300">
                {m.text ? (
                  <Markdown text={m.text} onCite={onCite} />
                ) : m.status === "streaming" ? (
                  <div className="flex items-center gap-2 py-1">
                    <span className="cl-typing"><i /><i /><i /></span>
                    <span className="text-[11px] font-mono text-stone-500">{m.sources.length ? `Reading ${m.sources.length} code excerpts and the analysis…` : "Analyzing the codebase…"}</span>
                  </div>
                ) : null}
                {m.status === "streaming" && m.text && <span className="cl-caret" />}
                {m.status === "error" && (
                  <div className="mt-2 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{m.error}</div>
                )}
              </div>
              {m.sources.length > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() => setOpenSources((s) => ({ ...s, [m.id]: !s[m.id] }))}
                    className="text-[10px] font-mono text-stone-500 hover:text-stone-300"
                  >
                    {openSources[m.id] ? "▾" : "▸"} {m.sources.length} sources ({m.sources.filter((s) => s.kind === "graph").length} via graph)
                  </button>
                  {openSources[m.id] && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {m.sources.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => onCite(s)}
                          className={`cl-cite ${s.kind === "graph" ? "cl-cite-graph" : ""}`}
                          title={s.kind === "graph" ? `Neighbor of ${s.via}` : `Relevance ${s.score}`}
                        >
                          <span className="cl-cite-file">{s.file.split("/").pop()}</span>
                          <span className="cl-cite-lines">L{s.startLine}–{s.endLine}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="shrink-0 p-4 border-t border-[#2e2a27] bg-[#0b0a09]/90"
      >
        <div className="flex items-end gap-2 rounded-2xl border border-[#2e2a27] bg-[#141110] focus-within:border-[#ff5330]/60 focus-within:shadow-[0_0_0_3px_rgba(255,83,48,0.12)] transition px-3 py-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = Math.min(140, e.currentTarget.scrollHeight) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            placeholder={repoUrl ? (status?.unreachable ? "Backend unreachable: is the server running?" : status?.ready ? (messages.length ? "Ask a follow-up…" : "Ask how something works…") : "Indexing… you can type already") : "Analyze a repository first"}
            disabled={!repoUrl}
            className="flex-1 resize-none bg-transparent outline-none text-[13px] text-stone-100 placeholder:text-stone-600 py-1.5 max-h-[140px]"
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="shrink-0 h-9 px-3 rounded-xl bg-[#2a2120] text-stone-200 text-xs font-mono border border-[#3d2c28] hover:border-[#ff5330]/50">
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || !status?.ready}
              className="shrink-0 h-9 w-9 rounded-xl bg-[#ff5330] text-white flex items-center justify-center hover:bg-[#ff6a4a] active:scale-95 transition disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="Send question"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[9px] font-mono text-stone-600 text-center">Enter to send · Shift+Enter for a new line · answers cite file:line</div>
      </form>
    </aside>
  );
}
