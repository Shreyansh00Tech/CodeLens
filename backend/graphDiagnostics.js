/**
 * Main function to analyze graph structure
 * @param {Array} nodes - [{ id: 'src/index.js', lines: 120 }, ...]
 * @param {Array} links - [{ source: 'src/a.js', target: 'src/b.js' }, ...]
 */
export function analyzeGraphDiagnostics(nodes = [], links = []) {
  const adjList = new Map();
  const revAdjList = new Map();
  const inDegree = new Map();
  const outDegree = new Map();

  // Initialize graph structures
  nodes.forEach(node => {
    adjList.set(node.id, []);
    revAdjList.set(node.id, []);
    inDegree.set(node.id, 0);
    outDegree.set(node.id, 0);
  });

  links.forEach(link => {
    const u = link.source;
    const v = link.target;
    if (adjList.has(u) && adjList.has(v)) {
      adjList.get(u).push(v);
      revAdjList.get(v).push(u);
      outDegree.set(u, outDegree.get(u) + 1);
      inDegree.set(v, inDegree.get(v) + 1);
    }
  });

  // 1. CIRCULAR DEPENDENCY DETECTION (Tarjan's strongly connected components)
  // Every SCC with more than one file is a dependency cycle. Each is reported once,
  // as a closed walk (A -> B -> ... -> A) whose consecutive pairs are real edges.
  const circularDependencies = findCircularDependencies(nodes.map(n => n.id), adjList);

  // 2. DEAD / ORPHAN CODE DETECTION (In-Degree = 0)
  const entryPointPatterns = [
    /server\.(js|ts)$/i,
    /index\.(js|ts|jsx|tsx)$/i,
    /main\.(js|ts|jsx|tsx)$/i,
    /app\.(js|ts|jsx|tsx)$/i,
    /\.config\.(js|ts|json)$/i,
    /setupTests\.(js|ts)$/i,
    // Tests, scripts and type declarations are entry points by nature, not dead code.
    /(^|\/)(__tests__|tests?|spec|e2e|cypress)\//i,
    /\.(test|spec)\.[a-z0-9]+$/i,
    /(^|\/)test_[^/]+\.py$|_test\.py$/i,
    /(^|\/)(bin|scripts)\//i,
    /\.d\.ts$/i,
    /(^|\/)__init__\.py$|(^|\/)__main__\.py$|(^|\/)manage\.py$|(^|\/)setup\.py$/i,
    /vite\.config|webpack\.config|jest\.config|eslint\.config|babel\.config/i
  ];

  const deadCode = [];
  nodes.forEach(node => {
    const isInDegreeZero = inDegree.get(node.id) === 0;
    const isEntryPoint = entryPointPatterns.some(pattern => pattern.test(node.id));

    if (isInDegreeZero && !isEntryPoint) {
      deadCode.push({
        file: node.id,
        inDegree: 0,
        lines: node.lines || 0
      });
    }
  });

  // 3. TIGHT COUPLING / GOD MODULES (Coupling Metric = In-Degree * Out-Degree)
  const tightCouplings = [];
  const GOD_MODULE_THRESHOLD = 50; // Threshold for god modules

  nodes.forEach(node => {
    const fanIn = inDegree.get(node.id);
    const fanOut = outDegree.get(node.id);
    const couplingScore = fanIn * fanOut;

    if (couplingScore >= GOD_MODULE_THRESHOLD || fanIn > 15 || fanOut > 15) {
      tightCouplings.push({
        file: node.id,
        fanIn,
        fanOut,
        score: couplingScore,
        severity: couplingScore > 200 ? 'CRITICAL' : 'HIGH'
      });
    }
  });

  // 4. OVERALL HEALTH SCORE CALCULATION (0 - 100%)
  const totalFiles = nodes.length || 1;
  const cyclePenalty = Math.min(40, circularDependencies.length * 10);
  const deadCodePenalty = Math.min(30, (deadCode.length / totalFiles) * 50);
  const couplingPenalty = Math.min(30, tightCouplings.length * 8);

  const healthScore = Math.max(0, Math.round(100 - (cyclePenalty + deadCodePenalty + couplingPenalty)));

  // Return formatted response for Frontend UI
  return {
    healthScore,
    summary: {
      totalIssues: circularDependencies.length + deadCode.length + tightCouplings.length,
      circularCount: circularDependencies.length,
      deadCodeCount: deadCode.length,
      tightCouplingCount: tightCouplings.length
    },
    diagnostics: {
      circularDependencies,
      deadCode,
      tightCouplings
    }
  };
}

/**
 * Iterative Tarjan SCC (no recursion, so deep import chains cannot overflow the stack).
 * Returns components with more than one node, largest first.
 */
export function stronglyConnectedComponents(ids, adjList) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];

  for (const start of ids) {
    if (index.has(start)) continue;
    const work = [{ v: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];
      const nbrs = adjList.get(frame.v) || [];
      if (frame.i < nbrs.length) {
        const w = nbrs[frame.i++];
        if (!adjList.has(w)) continue; // dangling edge: ignore
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        }
        continue;
      }
      if (low.get(frame.v) === index.get(frame.v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.v);
        if (comp.length > 1) components.push(comp);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(frame.v)));
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || String(a[0]).localeCompare(String(b[0])));
}

/** Shortest path from `from` to `to` using only edges inside `members`; includes both ends. */
function shortestPathWithin(from, to, adjList, members) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const nxt of adjList.get(cur) || []) {
      if (!members.has(nxt) || prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === to) {
        const out = [to];
        let at = cur;
        while (at !== null) {
          out.push(at);
          at = prev.get(at);
        }
        return out.reverse();
      }
      queue.push(nxt);
    }
  }
  return [from];
}

function findCircularDependencies(ids, adjList) {
  const MAX_LABEL_FILES = 8;
  return stronglyConnectedComponents(ids, adjList).map((comp, i) => {
    const members = new Set(comp);
    const sorted = [...comp].sort();
    const start = sorted[0];
    // Closed walk covering every member: hop to each unvisited member by shortest path.
    const walk = [start];
    const covered = new Set([start]);
    let at = start;
    for (const target of sorted) {
      if (covered.has(target)) continue;
      const leg = shortestPathWithin(at, target, adjList, members);
      for (const step of leg.slice(1)) {
        walk.push(step);
        covered.add(step);
      }
      at = target;
    }
    walk.push(...shortestPathWithin(at, start, adjList, members).slice(1));

    const label = walk.length > MAX_LABEL_FILES + 1
      ? `${walk.slice(0, MAX_LABEL_FILES).join(' → ')} → … (${comp.length} files in cycle)`
      : walk.join(' → ');
    return { id: `cycle-${i + 1}`, path: walk, formatted: label, size: comp.length };
  });
}
