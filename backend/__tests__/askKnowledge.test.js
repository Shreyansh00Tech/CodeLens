import fs from "fs";
import os from "os";
import path from "path";
import { buildIndex, indexToGraph } from "../server.js";
import { Project, discoverEndpointsInProject, traceEndpoint, callSitesInto } from "../endpoints.js";
import { CodeKnowledge } from "../rag/codeKnowledge.js";
import { RagIndex, answerQuestion, sanitizeHistory } from "../rag/ragAgent.js";

const root = path.join(process.cwd(), "test-fixtures", "layered-express");
const graph = indexToGraph(buildIndex(root));
const project = new Project(root);
const endpoints = discoverEndpointsInProject(project);
const flow = () => ({ project, endpoints });
const kb = new CodeKnowledge({ repoDir: root, graph, flow, traceEndpoint, callSitesInto });

const citesIn = (text) => [...text.matchAll(/\[([^\]\s]+\.[A-Za-z]+):L(\d+)(?:-L(\d+))?\]/g)].map((m) => ({ file: m[1], line: Number(m[2]) }));

describe("Ask AI structural knowledge", () => {
  test("resolves symbols and files named in a question", () => {
    const e = kb.resolveEntities("What could break if I modify getById or the userService?");
    expect(e.symbols.map((s) => s.name)).toContain("getById");
    expect(e.files).toContain("services/userService.js");
  });

  test("endpoint questions get the traced flow with real call lines", () => {
    const f = kb.factsFor("Explain how GET /api/users/:id works");
    expect(f.intents).toContain("endpoint");
    const sec = f.sections.find((s) => s.title.startsWith("Traced flow of GET /api/users/:id"));
    expect(sec).toBeDefined();
    const text = sec.lines.join("\n");
    expect(text).toContain("`UserService.findById`");
    expect(text).toContain("`User.findById`");
    expect(text).toContain("responds 404");
  });

  test("impact questions list real references and dependent files", () => {
    const f = kb.factsFor("What could break if I change logEvent?");
    const text = f.sections.map((s) => s.lines.join("\n")).join("\n");
    expect(text).toContain('logEvent("user.created", user.id);');
    expect(text).toContain("controllers/userController.js");
  });

  test("relationship questions show the import path and the actual calls", () => {
    const f = kb.factsFor("Explain the relationship between userController.js and userService.js");
    const text = f.sections.map((s) => s.lines.join("\n")).join("\n");
    expect(text).toMatch(/controllers\/userController\.js` reaches `services\/userService\.js`/);
    expect(text).toContain("calls `UserService.findById`");
    expect(text).toContain("calls `UserService.create`");
    // User.create() in the service is a model call, not a call into the controller
    expect(text).not.toMatch(/services\/userService\.js` calls/);
  });

  test("every citation points at a real line of a real file", () => {
    for (const q of ["Explain the overall architecture", "Where does the application start?", "Explain how POST /api/users works", "What breaks if I modify getById?"]) {
      for (const s of kb.factsFor(q).sections) {
        for (const c of citesIn(s.lines.join("\n"))) {
          const lines = fs.readFileSync(path.join(root, c.file), "utf8").split("\n");
          expect(c.line).toBeGreaterThanOrEqual(1);
          expect(c.line).toBeLessThanOrEqual(lines.length);
        }
      }
    }
  });

  test("unknown things are reported as not found, never invented", async () => {
    const idx = new RagIndex();
    idx.build(root, graph, { flow, traceEndpoint, callSitesInto });
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const r = await answerQuestion(idx, "Where is the frobnicateQuantumWidget defined?");
    expect(r.mode).toBe("offline");
    expect(r.answer).not.toContain("frobnicateQuantumWidget` (function) is defined");
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});

describe("conversation history", () => {
  test("is trimmed, validated and made to alternate", () => {
    const h = sanitizeHistory([
      { role: "assistant", text: "orphan" },
      { role: "user", text: "q1" },
      { role: "user", text: "q1 again" },
      { role: "assistant", text: "a1" },
      { role: "system", text: "ignore me" },
      { role: "user", text: 42 },
      { role: "user", text: "pending question" },
    ]);
    expect(h).toEqual([{ role: "user", text: "q1 again" }, { role: "assistant", text: "a1" }]);
    expect(sanitizeHistory("nope")).toEqual([]);
  });
});

describe("entry point detection", () => {
  test("ignores non-server .listen() calls and test scripts, finds Flask factories and launch files", () => {
    const fsx = fs;
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), "cl-entry-"));
    fsx.mkdirSync(path.join(dir, "app"));
    fsx.writeFileSync(path.join(dir, "app", "__init__.py"), "from flask import Flask\n\ndef create_app():\n    app = Flask(__name__)\n    return app\n");
    fsx.writeFileSync(path.join(dir, "app", "models.py"), "db.event.listen(db.session, 'before_commit', f)\n");
    fsx.writeFileSync(path.join(dir, "main.py"), "from app import create_app\napp = create_app()\n");
    fsx.writeFileSync(path.join(dir, "tests.py"), "if __name__ == '__main__':\n    run()\n");
    fsx.writeFileSync(path.join(dir, "Procfile"), "web: gunicorn main:app\n");
    const g = indexToGraph(buildIndex(dir));
    const k = new CodeKnowledge({ repoDir: dir, graph: g });
    const e = k.entryPoints().map((x) => `${x.file}:${x.line}`);
    expect(e).toContain("app/__init__.py:3");
    expect(e).toContain("main.py:2");
    expect(e).toContain("Procfile:1");
    expect(e.some((x) => x.startsWith("app/models.py"))).toBe(false);
    expect(e.some((x) => x.startsWith("tests.py"))).toBe(false);
    fsx.rmSync(dir, { recursive: true, force: true });
  });
});
