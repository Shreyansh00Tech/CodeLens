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

  // 1. CIRCULAR DEPENDENCY DETECTION (3-Color DFS)
  const circularDependencies = [];
  const state = new Map(); // 0: Unvisited, 1: Visiting, 2: Visited
  nodes.forEach(n => state.set(n.id, 0));

  function dfsCycle(u, path) {
    state.set(u, 1);
    path.push(u);

    for (const v of adjList.get(u) || []) {
      if (state.get(v) === 1) {
        // Cycle detected
        const cycleStartIndex = path.indexOf(v);
        const cyclePath = path.slice(cycleStartIndex);
        cyclePath.push(v); // Complete cycle format: A -> B -> C -> A
        circularDependencies.push({
          id: `cycle-${circularDependencies.length + 1}`,
          path: cyclePath,
          formatted: cyclePath.join(' → ')
        });
      } else if (state.get(v) === 0) {
        dfsCycle(v, [...path]);
      }
    }
    state.set(u, 2);
  }

  nodes.forEach(node => {
    if (state.get(node.id) === 0) {
      dfsCycle(node.id, []);
    }
  });

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
