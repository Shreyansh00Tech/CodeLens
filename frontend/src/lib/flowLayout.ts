/**
 * Layered left-to-right layout for API flow graphs.
 *
 * Request flows are mostly DAGs that start at one endpoint, so a Sugiyama-
 * style layout reads best: layer = longest path from the entry, order inside
 * a layer = barycenter of neighbours (a few sweeps to reduce crossings).
 * Back edges (recursion / cycles) are detected with a DFS and drawn as arcs.
 */
import type { FlowEdge, FlowNode } from "./types";

export const NODE_W = 204;
export const NODE_H = 58;
const GAP_X = 70;
const GAP_Y = 18;

export type LaidOutNode = FlowNode & { x: number; y: number; layer: number; hiddenChildren: number };
export type LaidOutEdge = FlowEdge & { back: boolean; d: string; mid: { x: number; y: number } };
export type FlowLayout = {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  byId: Map<string, LaidOutNode>;
  bounds: { x: number; y: number; w: number; h: number };
  layers: string[][];
};

export function layoutFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  entryId: string,
  opts: { collapsed?: Set<string>; hiddenKinds?: Set<string> } = {},
): FlowLayout {
  const collapsed = opts.collapsed ?? new Set<string>();
  const hiddenKinds = opts.hiddenKinds ?? new Set<string>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }
  for (const list of out.values()) list.sort((a, b) => a.order - b.order);

  // Visible set: reachable from the entry without passing through collapsed
  // nodes. Nodes whose kind is hidden are bypassed along the main request
  // chain (next / handles) so the rest of the flow stays connected; their
  // own sub-calls are hidden with them.
  const isHidden = (id: string) => id !== entryId && hiddenKinds.has(kindGroup(nodeById.get(id)?.kind || ""));
  const visible = new Set<string>();
  const discovery: string[] = [];
  const bypass: FlowEdge[] = [];
  const seenHidden = new Set<string>();
  const visit = (id: string) => {
    if (visible.has(id) || !nodeById.has(id)) return;
    visible.add(id);
    discovery.push(id);
    if (collapsed.has(id)) return;
    for (const e of out.get(id) || []) {
      if (!isHidden(e.to)) { visit(e.to); continue; }
      // Walk through hidden nodes along the chain until a visible one appears
      let cur = e.to;
      let guard = 0;
      while (cur && isHidden(cur) && guard++ < 200) {
        seenHidden.add(cur);
        const chain = (out.get(cur) || []).find((x) => x.kind === "next" || x.kind === "handles");
        cur = chain ? chain.to : "";
      }
      if (cur && !isHidden(cur)) {
        bypass.push({ ...e, id: `bypass:${id}->${cur}`, to: cur, kind: "next", lines: [], count: 1, conditional: false });
        visit(cur);
      }
    }
  };
  visit(entryId);

  // Count hidden descendants for collapsed nodes (for the "+N" badge)
  const hiddenCount = new Map<string, number>();
  for (const id of collapsed) {
    if (!visible.has(id)) continue;
    const seen = new Set<string>([id]);
    const q = [...(out.get(id) || []).map((e) => e.to)];
    while (q.length) {
      const c = q.pop()!;
      if (seen.has(c) || visible.has(c)) continue;
      seen.add(c);
      q.push(...(out.get(c) || []).map((e) => e.to));
    }
    hiddenCount.set(id, seen.size - 1);
  }

  const bypassIds = new Set<string>();
  const visEdges = [...edges.filter((e) => visible.has(e.from) && visible.has(e.to) && !collapsed.has(e.from)), ...bypass].filter((e) => {
    if (!e.id.startsWith("bypass:")) return true;
    if (bypassIds.has(e.id)) return false;
    bypassIds.add(e.id);
    return true;
  });

  // Back-edge detection (DFS from entry, edges in call order)
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const visOut = new Map<string, FlowEdge[]>();
  for (const e of visEdges) {
    if (!visOut.has(e.from)) visOut.set(e.from, []);
    visOut.get(e.from)!.push(e);
  }
  for (const list of visOut.values()) list.sort((a, b) => a.order - b.order);
  const dfs = (id: string) => {
    state.set(id, 1);
    for (const e of visOut.get(id) || []) {
      const s = state.get(e.to);
      if (s === 1 || e.from === e.to) back.add(e.id);
      else if (!s) dfs(e.to);
    }
    state.set(id, 2);
  };
  dfs(entryId);

  // Longest-path layering on the forward DAG (topological order via Kahn)
  const indeg = new Map<string, number>();
  for (const id of visible) indeg.set(id, 0);
  for (const e of visEdges) if (!back.has(e.id)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const layer = new Map<string, number>();
  const queue = [...visible].filter((id) => (indeg.get(id) || 0) === 0);
  for (const id of queue) layer.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of visOut.get(id) || []) {
      if (back.has(e.id)) continue;
      layer.set(e.to, Math.max(layer.get(e.to) || 0, (layer.get(id) || 0) + 1));
      indeg.set(e.to, (indeg.get(e.to) || 0) - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }

  const maxLayer = Math.max(0, ...layer.values());
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  const discIndex = new Map(discovery.map((id, i) => [id, i]));
  for (const id of discovery) layers[layer.get(id) ?? 0].push(id);

  // Barycenter crossing reduction
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of visEdges) {
    if (back.has(e.id)) continue;
    if (!preds.has(e.to)) preds.set(e.to, []);
    preds.get(e.to)!.push(e.from);
    if (!succs.has(e.from)) succs.set(e.from, []);
    succs.get(e.from)!.push(e.to);
  }
  const pos = new Map<string, number>();
  const reindex = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  reindex();
  const bary = (id: string, nb: Map<string, string[]>) => {
    const list = nb.get(id);
    if (!list || !list.length) return pos.get(id)!;
    return list.reduce((s, x) => s + (pos.get(x) ?? 0), 0) / list.length;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const li of range) {
      const nb = down ? preds : succs;
      const scored = layers[li].map((id) => ({ id, b: bary(id, nb), d: discIndex.get(id)! }));
      scored.sort((a, b) => a.b - b.b || a.d - b.d);
      layers[li] = scored.map((s) => s.id);
      layers[li].forEach((id, i) => pos.set(id, i));
    }
  }

  // Coordinates: layers centred vertically on y = 0
  const laid = new Map<string, LaidOutNode>();
  layers.forEach((ids, li) => {
    const total = ids.length * NODE_H + (ids.length - 1) * GAP_Y;
    ids.forEach((id, i) => {
      const n = nodeById.get(id)!;
      laid.set(id, {
        ...n,
        layer: li,
        x: li * (NODE_W + GAP_X),
        y: -total / 2 + i * (NODE_H + GAP_Y),
        hiddenChildren: hiddenCount.get(id) || 0,
      });
    });
  });

  const laidEdges: LaidOutEdge[] = visEdges.map((e) => {
    const s = laid.get(e.from)!;
    const t = laid.get(e.to)!;
    const isBack = back.has(e.id);
    let d: string;
    let mid: { x: number; y: number };
    if (e.from === e.to) {
      const x = s.x + NODE_W - 30;
      const y = s.y;
      d = `M${x},${y} C${x + 10},${y - 46} ${x + 60},${y - 30} ${s.x + NODE_W},${y + 16}`;
      mid = { x: x + 30, y: y - 30 };
    } else if (isBack) {
      const sx = s.x + NODE_W / 2;
      const sy = s.y;
      const tx = t.x + NODE_W / 2;
      const ty = t.y;
      const lift = 60 + Math.abs(sx - tx) * 0.12;
      const top = Math.min(sy, ty) - lift;
      d = `M${sx},${sy} C${sx},${top} ${tx},${top} ${tx},${ty}`;
      mid = { x: (sx + tx) / 2, y: top + lift * 0.25 };
    } else {
      const sx = s.x + NODE_W;
      const sy = s.y + NODE_H / 2;
      const tx = t.x;
      const ty = t.y + NODE_H / 2;
      const dx = Math.max(40, (tx - sx) * 0.5);
      d = `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
      mid = { x: (sx + tx) / 2, y: (sy + ty) / 2 };
    }
    return { ...e, back: isBack, d, mid };
  });

  const all = [...laid.values()];
  const minX = Math.min(...all.map((n) => n.x));
  const minY = Math.min(...all.map((n) => n.y)) - 70; // room for back-edge arcs
  const maxX = Math.max(...all.map((n) => n.x + NODE_W)) + 40;
  const maxY = Math.max(...all.map((n) => n.y + NODE_H));
  return {
    nodes: all,
    edges: laidEdges,
    byId: laid,
    bounds: { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) },
    layers,
  };
}

/** Kinds grouped for legend filtering. */
export function kindGroup(kind: string): string {
  switch (kind) {
    case "controller":
    case "service":
    case "utility":
    case "function":
      return "logic";
    case "data":
    case "database":
      return "data";
    case "error":
    case "response":
      return "response";
    default:
      return kind;
  }
}

/** Ancestors + descendants of a node (for path highlighting). */
export function relatedIds(id: string, edges: FlowEdge[]): Set<string> {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e.from);
  }
  const res = new Set<string>([id]);
  const walk = (start: string, adj: Map<string, string[]>) => {
    const q = [start];
    const seen = new Set<string>([start]);
    while (q.length) {
      const c = q.pop()!;
      for (const n of adj.get(c) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        res.add(n);
        q.push(n);
      }
    }
  };
  walk(id, out);
  walk(id, inc);
  return res;
}

export type FlowStep = { node: FlowNode; depth: number; edge: FlowEdge | null; repeat: boolean };

/** Depth-first execution order (call order), for the step-by-step view. */
export function executionSteps(nodes: FlowNode[], edges: FlowEdge[], entryId: string, limit = 400): FlowStep[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }
  for (const l of out.values()) l.sort((a, b) => a.order - b.order);
  const steps: FlowStep[] = [];
  const expanded = new Set<string>();
  const visit = (id: string, depth: number, edge: FlowEdge | null) => {
    if (steps.length >= limit) return;
    const node = byId.get(id);
    if (!node) return;
    const repeat = expanded.has(id);
    steps.push({ node, depth, edge, repeat });
    if (repeat) return;
    expanded.add(id);
    for (const e of out.get(id) || []) {
      // middleware chain is sequential, not nested: keep it at the same depth
      const nextDepth = e.kind === "next" || e.kind === "handles" ? depth : depth + 1;
      visit(e.to, nextDepth, e);
    }
  };
  visit(entryId, 0, null);
  return steps;
}

/**
 * Collapse runs of "simple" middleware (no traced sub-calls of their own,
 * only a next/handles hand-off) into one group node so long global chains
 * (helmet → cors → json → …) don't dominate the canvas. Purely visual: the
 * group lists its members and can be expanded in place.
 */
export function groupMiddleware(nodes: FlowNode[], edges: FlowEdge[], entryId: string, expanded: Set<string>, minRun = 3): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  const inc = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e);
  }
  const simple = (id: string) => {
    const n = byId.get(id);
    if (!n || n.kind !== "middleware") return false;
    const o = out.get(id) || [];
    const i = inc.get(id) || [];
    return o.length === 1 && (o[0].kind === "next" || o[0].kind === "handles") && i.length === 1 && i[0].kind === "next";
  };
  // Walk the main chain from the entry
  const runs: string[][] = [];
  let cur: string | undefined = entryId;
  let run: string[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (simple(cur)) run.push(cur);
    else {
      if (run.length) runs.push(run);
      run = [];
    }
    const chain: FlowEdge | undefined = (out.get(cur) || []).find((e) => e.kind === "next" || e.kind === "handles");
    cur = chain?.to;
  }
  if (run.length) runs.push(run);

  const replace = new Map<string, string>(); // member id -> group id
  const groups: FlowNode[] = [];
  for (const r of runs) {
    if (r.length < minRun) continue;
    const gid = `group:${r[0]}`;
    if (expanded.has(gid)) continue;
    const first = byId.get(r[0])!;
    groups.push({
      ...first,
      id: gid,
      name: `${r.length} middleware`,
      detail: r.map((id) => byId.get(id)!.name).join(" → "),
      members: r,
      resolution: "resolved",
      package: null,
      unresolved: undefined,
    });
    for (const id of r) replace.set(id, gid);
  }
  if (!groups.length) return { nodes, edges };
  const newNodes = [...nodes.filter((n) => !replace.has(n.id)), ...groups];
  const newEdges: FlowEdge[] = [];
  const ids = new Set<string>();
  for (const e of edges) {
    const from = replace.get(e.from) || e.from;
    const to = replace.get(e.to) || e.to;
    if (from === to) continue;
    const id = from !== e.from || to !== e.to ? `${from}->${to}:${e.kind}` : e.id;
    if (ids.has(id)) continue;
    ids.add(id);
    newEdges.push(from !== e.from || to !== e.to ? { ...e, id, from, to } : e);
  }
  return { nodes: newNodes, edges: newEdges };
}
