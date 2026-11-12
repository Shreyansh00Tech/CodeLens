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
