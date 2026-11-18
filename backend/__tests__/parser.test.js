import { parseFile, parseFolderJS } from "../parser.js";
import fs from "fs-extra";
import path from "path";

describe("Parser", () => {
  const tempDir = path.join(process.cwd(), "tmp_test");

  beforeAll(() => {
    fs.ensureDirSync(tempDir);

    fs.writeFileSync(
      path.join(tempDir, "a.js"),
      `import b from "./b.js";`
    );

    fs.writeFileSync(
      path.join(tempDir, "b.js"),
      `export const b = 1;`
    );
  });

  afterAll(() => {
    fs.removeSync(tempDir);
  });

  test("parseFile extracts imports", () => {
    const imports = parseFile(path.join(tempDir, "a.js"));
    expect(imports).toContain("./b.js");
  });

  test("parseFolderJS returns graph", () => {
    const graph = parseFolderJS(tempDir);

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.links.length).toBeGreaterThan(0);
  });

  test("graph structure is valid", () => {
    const graph = parseFolderJS(tempDir);

    expect(graph).toHaveProperty("nodes");
    expect(graph).toHaveProperty("links");
    expect(graph).toHaveProperty("backLinks");
  });
});
// ---------------------------------------------------------------------------
// Python import graph
// ---------------------------------------------------------------------------
import { extractPyImports, resolvePyImport, indexToGraph } from "../server.js";

describe("python imports", () => {
  test("extracts absolute, relative and multi-line imports", () => {
    const src = [
      "import os, sys as s",
      "import pkg.util",
      "from .core import Foo, bar as b",
      "from .. import shared",
      "from pkg.sub import (",
      "    a,",
      "    b,  # comment",
      ")",
    ].join("\n");
    const imps = extractPyImports(src);
    expect(imps).toEqual(
      expect.arrayContaining([
        { level: 0, module: "pkg.util", names: [] },
        { level: 1, module: "core", names: ["Foo", "bar"] },
        { level: 2, module: "", names: ["shared"] },
        { level: 0, module: "pkg.sub", names: ["a", "b"] },
      ])
    );
  });

  test("resolves relative, absolute and src-layout imports", () => {
    const files = new Set([
      "src/pkg/__init__.py",
      "src/pkg/core.py",
      "src/pkg/util/__init__.py",
      "src/pkg/util/helpers.py",
      "tests/test_core.py",
    ]);
    expect(resolvePyImport("src/pkg/__init__.py", { level: 1, module: "core", names: ["Foo"] }, files))
      .toEqual(["src/pkg/core.py"]);
    expect(resolvePyImport("src/pkg/core.py", { level: 1, module: "util", names: ["helpers"] }, files).sort())
      .toEqual(["src/pkg/util/__init__.py", "src/pkg/util/helpers.py"]);
    expect(resolvePyImport("tests/test_core.py", { level: 0, module: "pkg.core", names: [] }, files))
      .toEqual(["src/pkg/core.py"]);
    expect(resolvePyImport("tests/test_core.py", { level: 0, module: "os", names: [] }, files))
      .toEqual([]);
  });

  test("indexToGraph links python files and fills backLinks", () => {
    const g = indexToGraph({
      "a/__init__.py": { imports: [], lines: 1, pyImports: [] },
      "a/x.py": { imports: [], lines: 2, pyImports: [{ level: 1, module: "y", names: [] }] },
      "a/y.py": { imports: [], lines: 3, pyImports: [] },
    });
    expect(g.links).toEqual([{ source: "a/x.py", target: "a/y.py" }]);
    expect(g.backLinks["a/y.py"]).toEqual(["a/x.py"]);
  });
});
