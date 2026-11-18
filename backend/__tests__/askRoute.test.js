import { app } from "../server.js";

describe("versioned ask route", () => {
  let server;
  let base;

  beforeAll(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (url, body) =>
    fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("rejects an empty question on /api/v1/repos/:id/ask", async () => {
    const res = await post("/api/v1/repos/demo/ask", { question: "   " });
    expect(res.status).toBe(400);
  });

  test("asks the user to analyze a repository first when nothing is indexed", async () => {
    const res = await post("/api/v1/repos/demo/ask", { question: "How does auth work?" });
    expect(res.status).toBe(409);
  });

  test("legacy /ask behaves identically", async () => {
    const res = await post("/ask", { question: "" });
    expect(res.status).toBe(400);
  });
});
