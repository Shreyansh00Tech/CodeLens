/**
 * RAG agent for codebase Q&A.
 *
 * Pipeline: hybrid vector search -> 1-hop dependency-graph expansion
 * (callers / callees / imports of the retrieved files) -> grounded prompt ->
 * Claude answer with file:line citations.
 *
 * Without Anthropic credentials the agent still answers in "offline" mode:
 * it returns the most relevant code locations with citations instead of a
 * generated explanation, so the feature never breaks.
 */
import Anthropic from "@anthropic-ai/sdk";
import { chunkRepository } from "./chunker.js";
import { VectorStore } from "./vectorStore.js";

export const MODEL = process.env.CODELENS_MODEL || "claude-opus-5-5";

const TOP_K = 8;
const MAX_EXPANSION = 6;
const MAX_CONTEXT_CHARS = 60000;

export const SYSTEM_PROMPT = `You are CodeLens, a codebase Q&A assistant. You answer questions about one software repository using ONLY the source excerpts provided in the user turn.

Grounding rules:
- Every factual claim about the code must be backed by a citation in the exact form [path/to/file.ext:L12-L40], using a file and line range that appears in the provided excerpts. Cite the narrowest range that supports the claim.
- If the excerpts do not contain enough information to answer, say so plainly (for example: "I couldn't find this in the indexed code.") and point to the closest relevant locations you did see. Do not guess, and do not fill gaps with general knowledge about how such projects usually work.
- Excerpts marked "graph neighbor" were added because they import, or are imported by, a retrieved file. Use them to explain call flow between files.

Format: GitHub-flavored Markdown. Start with a one or two sentence direct answer, then supporting detail as short paragraphs or a bulleted list. Use fenced code blocks only for short, essential snippets. Keep it under about 350 words unless the question needs more.`;

function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export class RagIndex {
  constructor() {
    this.store = new VectorStore();
    this.neighbors = new Map(); // file -> Set(file)
    this.repoDir = null;
    this.builtAt = null;
  }

  get ready() {
    return this.store.size > 0;
  }

  build(repoDir, graph) {
    this.store = new VectorStore();
    this.store.addAll(chunkRepository(repoDir));
    this.neighbors = new Map();
    for (const link of graph?.links || []) {
      const s = typeof link.source === "string" ? link.source : link.source?.id;
      const t = typeof link.target === "string" ? link.target : link.target?.id;
      if (!s || !t) continue;
      if (!this.neighbors.has(s)) this.neighbors.set(s, new Set());
      if (!this.neighbors.has(t)) this.neighbors.set(t, new Set());
      this.neighbors.get(s).add(t);
      this.neighbors.get(t).add(s);
    }
    this.repoDir = repoDir;
    this.builtAt = new Date().toISOString();
    return { chunks: this.store.size };
  }

  /** Vector search + 1-hop graph expansion. */
  retrieve(question) {
    const hits = this.store.search(question, TOP_K).filter((h) => h.score > 0.02);
    const seen = new Set(hits.map((h) => h.chunk.id));
    const hitFiles = new Set(hits.map((h) => h.chunk.file));

    const expansion = [];
    for (const file of hitFiles) {
      for (const nb of this.neighbors.get(file) || []) {
        if (hitFiles.has(nb)) continue;
        const best = this.store.bestInFile(question, nb);
        if (best && !seen.has(best.chunk.id)) {
          seen.add(best.chunk.id);
          expansion.push({ ...best, via: file });
        }
      }
    }
    expansion.sort((a, b) => b.score - a.score);

    return {
      hits: hits.map((h) => ({ ...h, kind: "retrieved" })),
      expansion: expansion.slice(0, MAX_EXPANSION).map((h) => ({ ...h, kind: "graph" })),
    };
  }
}

export function toCitation(entry) {
  const c = entry.chunk;
  return {
    file: c.file,
    startLine: c.startLine,
    endLine: c.endLine,
    symbols: c.symbols,
    score: Number(entry.score.toFixed(3)),
    kind: entry.kind,
    via: entry.via || null,
  };
}

export function buildContext(entries) {
  let used = 0;
  const blocks = [];
  for (const e of entries) {
    const c = e.chunk;
    const label = e.kind === "graph" ? `graph neighbor of ${e.via}` : "retrieved";
    const numbered = c.text
      .split("\n")
      .map((line, i) => `${String(c.startLine + i).padStart(4)}| ${line}`)
      .join("\n");
    const block = `<excerpt source="${c.file}:L${c.startLine}-L${c.endLine}" kind="${label}">\n${numbered}\n</excerpt>`;
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    used += block.length;
    blocks.push(block);
  }
  return blocks.join("\n\n");
}

function offlineAnswer(question, entries) {
  if (entries.length === 0) {
    return "I couldn't find anything in the indexed code that relates to this question. Try naming a file, function, or feature that appears in the repository.";
  }
  const lines = entries.slice(0, 6).map((e) => {
    const c = e.chunk;
    const sym = c.symbols?.length ? ` (\`${c.symbols.slice(0, 3).join("`, `")}\`)` : "";
    const why = e.kind === "graph" ? ` connected through \`${e.via}\`` : "";
    return `- [${c.file}:L${c.startLine}-L${c.endLine}]${sym}${why}`;
  });
  return [
    `**AI generation is offline** (no \`ANTHROPIC_API_KEY\` on the server), so here are the code locations most relevant to "${question}":`,
    "",
    ...lines,
    "",
    "Set `ANTHROPIC_API_KEY` on the backend to get a written, cited explanation.",
  ].join("\n");
}

/**
 * Answer a question. `onEvent` receives { type: "sources" | "delta" | "done" | "error" }.
 * Returns the final { answer, citations, mode }.
 */
export async function answerQuestion(index, question, onEvent = () => {}) {
  const { hits, expansion } = index.retrieve(question);
  const entries = [...hits, ...expansion];
  const citations = entries.map(toCitation);
  onEvent({ type: "sources", citations });

  if (!hasCredentials()) {
    const answer = offlineAnswer(question, entries);
    onEvent({ type: "delta", text: answer });
    return { answer, citations, mode: "offline" };
  }

  if (entries.length === 0) {
    const answer = "I couldn't find anything in the indexed code that relates to this question, so I can't answer it without guessing.";
    onEvent({ type: "delta", text: answer });
    return { answer, citations, mode: "llm" };
  }

  const context = buildContext(entries);
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Repository excerpts:\n\n${context}\n\nQuestion: ${question}`,
      },
    ],
  });

  let answer = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      answer += event.delta.text;
      onEvent({ type: "delta", text: event.delta.text });
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    const note = "\n\n_The model declined to answer this question._";
    answer += note;
    onEvent({ type: "delta", text: note });
  } else if (final.stop_reason === "max_tokens") {
    const note = "\n\n_(Answer truncated.)_";
    answer += note;
    onEvent({ type: "delta", text: note });
  }
  return { answer, citations, mode: "llm", model: final.model };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The server's Anthropic API key was rejected.";
  if (err instanceof Anthropic.RateLimitError) return "The AI service is rate limited right now. Try again in a moment.";
  if (err instanceof Anthropic.BadRequestError) return `The AI request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `AI service error (${err.status ?? "network"}).`;
  return err?.message || "Unknown error";
}
