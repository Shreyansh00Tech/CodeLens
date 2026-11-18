import { analyzeGraphDiagnostics } from "../graphDiagnostics.js";

describe("Graph diagnostics", () => {
  test("detects cycles, and does not flag tests or entry points as dead code", () => {
    const nodes = ["src/a.js", "src/b.js", "src/orphan.js", "test/a.test.js", "src/index.js"].map((id) => ({ id, lines: 10 }));
    const links = [
      { source: "src/a.js", target: "src/b.js" },
      { source: "src/b.js", target: "src/a.js" },
      { source: "test/a.test.js", target: "src/a.js" },
    ];
    const d = analyzeGraphDiagnostics(nodes, links);
    expect(d.summary.circularCount).toBe(1);
    expect(d.diagnostics.deadCode.map((x) => x.file)).toEqual(["src/orphan.js"]);
    expect(d.healthScore).toBeLessThan(100);
  });
});

describe("Tarjan SCC cycle detection", () => {
  const mk = (ids) => ids.map((id) => ({ id, lines: 5 }));
  const edge = (source, target) => ({ source, target });
  const assertClosedWalk = (path, links) => {
    expect(path[0]).toBe(path.at(-1));
    const set = new Set(links.map((l) => `${l.source}>${l.target}`));
    for (let i = 1; i < path.length; i++) expect(set.has(`${path[i - 1]}>${path[i]}`)).toBe(true);
  };

  test("reports each strongly connected component once, as a walk made of real edges", () => {
    const links = [
      edge("a", "b"), edge("b", "c"), edge("c", "a"), // 3-cycle
      edge("c", "d"), edge("d", "e"), edge("e", "d"), // separate 2-cycle
      edge("x", "a"), // feeder, not part of any cycle
    ];
    const d = analyzeGraphDiagnostics(mk(["a", "b", "c", "d", "e", "x"]), links);
    const cycles = d.diagnostics.circularDependencies;
    expect(cycles).toHaveLength(2);
    expect(cycles.map((c) => c.size)).toEqual([3, 2]);
    for (const c of cycles) assertClosedWalk(c.path, links);
    expect(new Set(cycles[0].path)).toEqual(new Set(["a", "b", "c"]));
  });

  test("covers every file of a tangled component (|C| > 1)", () => {
    const links = [edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "b"), edge("c", "d"), edge("d", "c")];
    const d = analyzeGraphDiagnostics(mk(["a", "b", "c", "d"]), links);
    const [cycle] = d.diagnostics.circularDependencies;
    expect(new Set(cycle.path)).toEqual(new Set(["a", "b", "c", "d"]));
    assertClosedWalk(cycle.path, links);
  });

  test("acyclic graphs, self-imports and dangling edges produce no cycles and do not throw", () => {
    const links = [edge("a", "b"), edge("b", "c"), edge("c", "c"), edge("a", "missing"), edge("ghost", "a")];
    const d = analyzeGraphDiagnostics(mk(["a", "b", "c"]), links);
    expect(d.summary.circularCount).toBe(0);
  });

  test("handles a very deep import chain without overflowing the stack", () => {
    const N = 50000;
    const ids = Array.from({ length: N }, (_, i) => `f${i}`);
    const links = ids.slice(1).map((id, i) => edge(ids[i], id));
    links.push(edge(ids[N - 1], ids[0]));
    const d = analyzeGraphDiagnostics(mk(ids), links);
    expect(d.summary.circularCount).toBe(1);
    expect(d.diagnostics.circularDependencies[0].size).toBe(N);
  });
});
