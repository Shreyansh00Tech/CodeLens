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
    .map(([id, d]) => ({ id, depth: d, isTest: isTestFile(id), endpoints: epByFile.get(id) || [] }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

  const tests = affected.filter((a) => a.isTest).map((a) => a.id);
  const apis = affected.flatMap((a) => a.endpoints);
  const files = affected.length - 1;
  const maxDepth = Math.max(0, ...affected.map((a) => a.depth));
  const total = Math.max(1, adj.out.size);

  // Blend blast radius, API exposure and depth into a 0-100 risk score.
  const riskScore = Math.min(
    100,
    Math.round((files / total) * 140 + apis.length * 6 + Math.min(maxDepth, 6) * 3 + (files > 0 ? 6 : 0))
  );
  const riskLabel = riskScore >= 70 ? "CRITICAL" : riskScore >= 40 ? "HIGH" : riskScore >= 15 ? "MEDIUM" : "LOW";

  const highlight: Highlight = { kind: "impact", source, ids: new Set(depth.keys()), depth, links };
  return { source, affected, files, tests, apis, maxDepth, riskScore, riskLabel, highlight };
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
