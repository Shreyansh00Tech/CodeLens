import type { Endpoint, GraphData, Highlight, ImpactResult } from "./types";

export const fileName = (p: string) => (p ? p.split("/").pop() || p : "");

const TEST_RE = /(^|\/)(__tests__|tests?|spec|e2e|cypress)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(py|go)$|(^|\/)test_[^/]+\.py$/i;
export const isTestFile = (p: string) => TEST_RE.test(p);

export type Adjacency = {
  out: Map<string, string[]>; // file -> files it imports
  in: Map<string, string[]>; // file -> files that import it
};

export function buildAdjacency(data: GraphData): Adjacency {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const n of data.nodes) {
    out.set(n.id, []);
    inc.set(n.id, []);
  }
  for (const l of data.links) {
    if (!out.has(l.source) || !out.has(l.target)) continue;
    out.get(l.source)!.push(l.target);
    inc.get(l.target)!.push(l.source);
  }
  return { out, in: inc };
}

/** Each extra hop away from the changed file keeps this share of its impact. */
export const PROXIMITY_DECAY = 0.6;

export const linkKey = (s: string, t: string) => `${s}→${t}`;

/**
 * "What if I change this file?" Reverse-transitive closure over the import
 * graph: every file that imports the source, directly or indirectly, may break.
 */
export function simulateImpact(source: string, adj: Adjacency, endpoints: Endpoint[]): ImpactResult {
  const depth = new Map<string, number>([[source, 0]]);
  const links = new Set<string>();
  const queue = [source];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const importer of adj.in.get(cur) || []) {
      links.add(linkKey(importer, cur));
      if (!depth.has(importer)) {
        depth.set(importer, d + 1);
        queue.push(importer);
      }
    }
  }

  const epByFile = new Map<string, Endpoint[]>();
  for (const ep of endpoints) {
    if (!epByFile.has(ep.filePath)) epByFile.set(ep.filePath, []);
    epByFile.get(ep.filePath)!.push(ep);
  }

  const affected = [...depth.entries()]
    .map(([id, d]) => ({ id, depth: d, proximity: Number((PROXIMITY_DECAY ** d).toFixed(4)), isTest: isTestFile(id), endpoints: epByFile.get(id) || [] }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

  const tests = affected.filter((a) => a.isTest).map((a) => a.id);
  const apis = affected.flatMap((a) => a.endpoints);
  const files = affected.length - 1;
  const weightedImpact = Number(affected.filter((a) => a.depth > 0).reduce((sum, a) => sum + a.proximity, 0).toFixed(3));
  const maxDepth = Math.max(0, ...affected.map((a) => a.depth));
  const total = Math.max(1, adj.out.size);

  // Blend blast radius, API exposure and depth into a 0-100 risk score.
  const riskScore = Math.min(
    100,
    Math.round((files / total) * 140 + apis.length * 6 + Math.min(maxDepth, 6) * 3 + (files > 0 ? 6 : 0))
  );
  const riskLabel = riskScore >= 70 ? "CRITICAL" : riskScore >= 40 ? "HIGH" : riskScore >= 15 ? "MEDIUM" : "LOW";

  const highlight: Highlight = { kind: "impact", source, ids: new Set(depth.keys()), depth, links };
  return { source, affected, files, weightedImpact, tests, apis, maxDepth, riskScore, riskLabel, highlight };
}

export function cycleHighlight(path: string[]): Highlight {
  const depth = new Map<string, number>();
  const links = new Set<string>();
  path.forEach((id, i) => {
    if (!depth.has(id)) depth.set(id, 0);
    if (i > 0) links.add(linkKey(path[i - 1], id));
  });
  return { kind: "cycle", ids: new Set(depth.keys()), depth, links };
}

/**
 * Dependency layers for the sunburst view. Layer 0 holds core modules that
 * import nothing internal; each higher layer depends on the ones inside it.
 * Cycles are collapsed (Tarjan SCC) so the layering is always well defined.
 */
export function computeLayers(data: GraphData, adj: Adjacency) {
  const ids = data.nodes.map((n) => n.id);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let compCount = 0;

  // Iterative Tarjan to stay safe on deep graphs.
  for (const start of ids) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const nbrs = adj.out.get(top.v) || [];
      if (top.i < nbrs.length) {
        const w = nbrs[top.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        }
      } else {
        if (low.get(top.v) === idx.get(top.v)) {
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, compCount);
          } while (w !== top.v);
          compCount++;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
      }
    }
  }

  // Height of each component in the condensed DAG (longest path to a sink).
  const compOut = new Map<number, Set<number>>();
  for (const v of ids) {
    const c = comp.get(v)!;
    if (!compOut.has(c)) compOut.set(c, new Set());
    for (const w of adj.out.get(v) || []) {
      const cw = comp.get(w)!;
      if (cw !== c) compOut.get(c)!.add(cw);
    }
  }
  // Tarjan emits components in reverse topological order: sinks first.
  const height = new Map<number, number>();
  for (let c = 0; c < compCount; c++) {
    let h = 0;
    for (const d of compOut.get(c) || []) h = Math.max(h, (height.get(d) ?? 0) + 1);
    height.set(c, h);
  }

  const layer = new Map<string, number>();
  const isolated: string[] = [];
  for (const v of ids) {
    const deg = (adj.out.get(v)?.length || 0) + (adj.in.get(v)?.length || 0);
    if (deg === 0) isolated.push(v);
    else layer.set(v, height.get(comp.get(v)!)!);
  }
  const maxLayer = Math.max(0, ...layer.values());
  return { layer, isolated, maxLayer };
}

export function folderOf(id: string, depth = 2) {
  const parts = id.split("/");
  parts.pop();
  return parts.slice(0, depth).join("/") || "(root)";
}

export function nodeCategoryColor(id: string): string {
  const p = id.toLowerCase();
  if (isTestFile(p)) return "#7dd3c0";
  if (p.includes("component")) return "#FF5A36";
  if (p.includes("page") || p.includes("view") || p.includes("route")) return "#FFD9BC";
  if (p.includes("util") || p.includes("helper") || p.includes("lib/")) return "#A79A90";
  if (p.includes("server") || p.includes("api") || p.includes("controller")) return "#FF8A6B";
  if (p.includes("service") || p.includes("store") || p.includes("model")) return "#ffb547";
  return "#f4ece6";
}

// ---------------------------------------------------------------------------
// Importance ranking + guided reading order ("Start here")
// ---------------------------------------------------------------------------

/**
 * PageRank over the import graph. Rank flows from an importer to the files it
 * imports, so the files everything else leans on end up on top. Dangling nodes
 * (no imports) spread their rank evenly, so the scores always sum to 1.
 */
export function pageRank(adj: Adjacency, damping = 0.85, iterations = 40): Map<string, number> {
  const ids = [...adj.out.keys()];
  const n = ids.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  for (const id of ids) rank.set(id, 1 / n);

  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (const id of ids) if ((adj.out.get(id)?.length ?? 0) === 0) dangling += rank.get(id)!;
    const base = (1 - damping) / n + (damping * dangling) / n;
    const next = new Map<string, number>();
    for (const id of ids) {
      let sum = 0;
      for (const importer of adj.in.get(id) || []) {
        const outDeg = adj.out.get(importer)?.length || 1;
        sum += rank.get(importer)! / outDeg;
      }
      next.set(id, base + damping * sum);
    }
    let delta = 0;
    for (const id of ids) delta += Math.abs(next.get(id)! - rank.get(id)!);
    for (const id of ids) rank.set(id, next.get(id)!);
    if (delta < 1e-9) break;
  }
  return rank;
}

const ENTRY_RE = /(^|\/)(index|main|app|server|cli|__main__|__init__|manage|wsgi|asgi|run|start)\.[a-z0-9]+$/i;
const AUX_RE = /(^|\/)(examples?|docs?|benchmarks?|scripts?|fixtures?|demos?)\//i;
const NOISE_RE = /(^|\/)(config|configs|\.config|conf|settings|types?|constants?|fixtures?|mocks?|stubs?|examples?|docs?|scripts?|benchmarks?)(\/|\.|$)|\.(config|d)\.[a-z]+$|\.(json|md|css)$/i;

export type StartHereItem = {
  id: string;
  /** 0-100, relative to the most central file of the repo. */
  score: number;
  role: "Core module" | "Entry point" | "Hub" | "API surface";
  reason: string;
};

/**
 * Suggests the handful of files a newcomer should read first, in an order that
 * makes sense: entry points and API surface give context, then the shared core
 * everything depends on. Tests, configs and typings are never suggested.
 */
export function startHere(fullAdj: Adjacency, endpoints: Endpoint[], limit = 8): StartHereItem[] {
  // Tests import the code under test, which would make every core module look "popular".
  // Rank on production imports only, but remember how many tests touch each file.
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  const testCount = new Map<string, number>(); // imports coming from tests / examples / docs
  const isAux = (p: string) => isTestFile(p) || AUX_RE.test(p);
  for (const id of fullAdj.out.keys()) {
    out.set(id, []);
    inc.set(id, []);
  }
  for (const [src, targets] of fullAdj.out) {
    for (const t of targets) {
      if (isAux(src)) testCount.set(t, (testCount.get(t) || 0) + 1);
      else {
        out.get(src)!.push(t);
        inc.get(t)!.push(src);
      }
    }
  }
  const adj: Adjacency = { out, in: inc };
  const rank = pageRank(adj);
  const epCount = new Map<string, number>();
  for (const ep of endpoints) epCount.set(ep.filePath, (epCount.get(ep.filePath) || 0) + 1);

  const candidates = [...rank.keys()].filter((id) => !isTestFile(id) && !NOISE_RE.test(id));
  if (candidates.length === 0) return [];
  const maxRank = Math.max(...candidates.map((id) => rank.get(id)!), 1e-12);

  const scored = candidates.map((id) => {
    const fanIn = adj.in.get(id)?.length ?? 0;
    const fanOut = adj.out.get(id)?.length ?? 0;
    const eps = epCount.get(id) || 0;
    const isEntry = ENTRY_RE.test(id) && fanIn <= 1 && fanOut > 0;
    // Centrality first; entry points and API files get a boost since they frame the codebase.
    const score = (rank.get(id)! / maxRank) * 100 + (isEntry ? 18 : 0) + Math.min(eps, 5) * 4;
    let role: StartHereItem["role"] = "Core module";
    const tests = testCount.get(id) || 0;
    const testNote = tests > 0 ? ` · ${tests} in tests/examples` : "";
    let reason = fanIn > 0 ? `Imported by ${fanIn} file${fanIn === 1 ? "" : "s"}${testNote}` : `Used by ${tests} test/example file${tests === 1 ? "" : "s"}`;
    if (eps > 0) {
      role = "API surface";
      reason = `Defines ${eps} endpoint${eps === 1 ? "" : "s"}${fanIn ? ` · used by ${fanIn}` : ""}${testNote}`;
    } else if (isEntry) {
      role = "Entry point";
      reason = `Wires together ${fanOut} module${fanOut === 1 ? "" : "s"}${testNote}`;
    } else if (fanIn >= 3 && fanOut >= 3) {
      role = "Hub";
      reason = `Connects ${fanIn} importers to ${fanOut} dependencies`;
    }
    return { id, score, role, reason };
  });

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = scored.filter((s) => s.score > 0).slice(0, limit);
  const best = Math.max(...top.map((t) => t.score), 1);

  // Reading order: entry points → API surface → hubs → shared core (each by score).
  const order: Record<StartHereItem["role"], number> = { "Entry point": 0, "API surface": 1, Hub: 2, "Core module": 3 };
  return top
    .map((t) => ({ ...t, score: Math.round(Math.min(100, (t.score / best) * 100)) }))
    .sort((a, b) => order[a.role] - order[b.role] || b.score - a.score);
}

// ---------------------------------------------------------------------------
// Fuzzy file search for the command palette
// ---------------------------------------------------------------------------

/** Subsequence match with bonuses for word starts, contiguous runs and the file name. Returns -1 for no match. */
export function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] === q[qi]) {
      const boundary = i === 0 || "/._-".includes(p[i - 1]);
      run++;
      score += 1 + run * 2 + (boundary ? 6 : 0) + (i >= nameStart ? 3 : 0);
      qi++;
    } else run = 0;
  }
  if (qi < q.length) return -1;
  if (p.slice(nameStart).includes(q)) score += 40;
  if (p.slice(nameStart).startsWith(q)) score += 25;
  return score - p.length * 0.05;
}
