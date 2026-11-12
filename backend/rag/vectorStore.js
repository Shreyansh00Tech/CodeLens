/**
 * Local hybrid vector store.
 *
 * Dense part: feature-hashed sparse-to-dense embeddings (no network, no model
 * download) built from code-aware tokens (camelCase / snake_case split,
 * bigrams). Lexical part: BM25 over the same tokens. The final score blends
 * both, which works well for code where exact identifiers matter.
 *
 * The store exposes the same surface a pgvector / Chroma adapter would
 * (add, search, size), so a hosted vector DB can be swapped in later.
 */

const DIM = 1024;

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on",
  "with", "as", "be", "this", "that", "are", "was", "how", "what", "where",
  "does", "do", "which", "who", "why", "when", "can", "i", "me", "my", "we",
  "you", "your", "from", "by", "at", "into", "about", "work", "works", "used",
  "use", "show", "tell", "explain", "there", "any", "all", "get",
]);

/** Code-aware tokenizer: splits identifiers into their parts too. */
export function tokenize(text) {
  const raw = String(text).match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) || [];
  const out = [];
  for (const word of raw) {
    const lower = word.toLowerCase();
    if (lower.length > 1 && !STOP.has(lower)) out.push(lower);
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_$]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1 && !STOP.has(p));
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

function hash(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function embed(text) {
  const vec = new Float32Array(DIM);
  const toks = tokenize(text);
  const add = (t, w) => {
    const h = hash(t);
    vec[h % DIM] += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (let i = 0; i < toks.length; i++) {
    add(toks[i], 1);
    if (i + 1 < toks.length) add(toks[i] + "_" + toks[i + 1], 0.5);
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    vec[i] = Math.sign(vec[i]) * Math.log1p(Math.abs(vec[i]));
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class VectorStore {
  constructor() {
    this.items = []; // { chunk, vec, tf, len }
    this.df = new Map();
    this.avgLen = 0;
  }

  get size() {
    return this.items.length;
  }

  addAll(chunks) {
    let totalLen = 0;
    for (const chunk of chunks) {
      // Path and symbols are strong retrieval signals, so index them with the body.
      const enriched = `${chunk.file} ${chunk.file} ${(chunk.symbols || []).join(" ")} ${chunk.text}`;
      const toks = tokenize(enriched);
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      totalLen += toks.length;
      this.items.push({ chunk, vec: embed(enriched), tf, len: toks.length });
    }
    this.avgLen = this.items.length ? totalLen / this.items.length : 0;
  }

  bm25(queryToks, item) {
    const k1 = 1.4;
    const b = 0.75;
    const N = this.items.length;
    let score = 0;
    for (const q of queryToks) {
      const f = item.tf.get(q);
      if (!f) continue;
      const df = this.df.get(q) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * item.len) / (this.avgLen || 1))));
    }
    return score;
  }

  /** Hybrid search; returns [{ chunk, score }] sorted best first. */
  search(query, k = 8) {
    if (this.items.length === 0) return [];
    const qVec = embed(query);
    const qToks = [...new Set(tokenize(query))];

    const scored = this.items.map((item) => ({
      item,
      dense: cosine(qVec, item.vec),
      lex: this.bm25(qToks, item),
    }));
    const maxLex = Math.max(1e-9, ...scored.map((s) => s.lex));

    return scored
      .map((s) => ({ chunk: s.item.chunk, score: 0.45 * s.dense + 0.55 * (s.lex / maxLex) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Best-matching chunk inside one specific file (used by graph expansion). */
  bestInFile(query, file) {
    const qVec = embed(query);
    let best = null;
    for (const item of this.items) {
      if (item.chunk.file !== file) continue;
      const s = cosine(qVec, item.vec);
      if (!best || s > best.score) best = { chunk: item.chunk, score: s };
    }
    return best;
  }
}
