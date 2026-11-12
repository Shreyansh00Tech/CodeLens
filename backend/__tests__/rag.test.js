import fs from "fs-extra";
import path from "path";
import { chunkText, chunkRepository } from "../rag/chunker.js";
import { VectorStore, tokenize } from "../rag/vectorStore.js";
import { RagIndex, answerQuestion, buildContext } from "../rag/ragAgent.js";
import { resolveImport, normalizeRepoUrl } from "../server.js";

describe("RAG chunker", () => {
  test("chunks keep exact line ranges", () => {
    const text = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const chunks = chunkText("a.js", text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks.at(-1).endLine).toBe(120);
    const lines = text.split("\n");
    for (const c of chunks) {
      expect(c.text).toBe(lines.slice(c.startLine - 1, c.endLine).join("\n"));
    }
  });

  test("tokenizer splits identifiers", () => {
    expect(tokenize("getUserById")).toEqual(expect.arrayContaining(["getuserbyid", "user", "id"]));
  });
});

describe("RAG retrieval + graph expansion", () => {
  const dir = path.join(process.cwd(), "tmp_rag_test");

  beforeAll(() => {
    fs.ensureDirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/auth.js"),
      `import { findUser } from "./db.js";\nexport async function login(email, password) {\n  const user = await findUser(email);\n  return verifyPassword(user, password);\n}\n`);
    fs.writeFileSync(path.join(dir, "src/db.js"),
      `export function findUser(email) {\n  return query("select * from users where email = ?", [email]);\n}\n`);
    fs.writeFileSync(path.join(dir, "src/chart.js"),
      `export function drawChart(points) { return points.map(p => p * 2); }\n`);
  });
  afterAll(() => fs.removeSync(dir));

  test("retrieves the relevant chunk and expands 1 hop", () => {
    const index = new RagIndex();
    index.build(dir, { links: [{ source: "src/auth.js", target: "src/db.js" }] });
    const { hits, expansion } = index.retrieve("how does login authentication work");
    expect(hits[0].chunk.file).toBe("src/auth.js");
    const files = [...hits, ...expansion].map((h) => h.chunk.file);
    expect(files).toContain("src/db.js");
  });

  test("offline mode answers with citations", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const index = new RagIndex();
    index.build(dir, { links: [] });
    const events = [];
    const result = await answerQuestion(index, "drawChart points", (e) => events.push(e.type));
    expect(result.mode).toBe("offline");
    expect(result.answer).toMatch(/\[src\/chart\.js:L1-L\d+\]/);
    expect(events).toEqual(["sources", "delta"]);
  });

  test("context is line-numbered", () => {
    const store = new VectorStore();
    store.addAll(chunkRepository(dir));
    const ctx = buildContext(store.search("findUser", 1).map((h) => ({ ...h, kind: "retrieved" })));
    expect(ctx).toMatch(/source="src\/db.js:L1-L\d+"/);
    expect(ctx).toMatch(/\s+1\| export function findUser/);
  });
});

describe("server helpers", () => {
  test("resolveImport handles extensions and index files", () => {
    const files = new Set(["src/a.ts", "src/lib/index.tsx", "src/b.jsx"]);
    expect(resolveImport("src/x.ts", "./a", files)).toBe("src/a.ts");
    expect(resolveImport("src/x.ts", "./a.js", files)).toBe("src/a.ts");
    expect(resolveImport("src/x.ts", "./lib", files)).toBe("src/lib/index.tsx");
    expect(resolveImport("src/x.ts", "./b", files)).toBe("src/b.jsx");
    expect(resolveImport("src/x.ts", "react", files)).toBeNull();
  });

  test("normalizeRepoUrl only accepts GitHub repos", () => {
    expect(normalizeRepoUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("https://github.com/a/b/")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("file:///etc")).toBeNull();
    expect(normalizeRepoUrl("https://evil.com/a/b")).toBeNull();
    expect(normalizeRepoUrl("ext::sh -c touch% /tmp/x")).toBeNull();
  });
});
