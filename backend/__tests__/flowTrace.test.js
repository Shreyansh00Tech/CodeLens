import path from "path";
import { Project, discoverEndpointsInProject, traceEndpoint } from "../endpoints.js";

const root = path.join(process.cwd(), "test-fixtures", "layered-express");
const project = new Project(root);
const endpoints = discoverEndpointsInProject(project);
const find = (m, p) => endpoints.find((e) => e.method === m && e.path === p);
const names = (t) => new Set(t.nodes.map((n) => n.name));
const edge = (t, from, to) => {
  const byName = new Map(t.nodes.map((n) => [n.id, n.name]));
  return t.edges.find((e) => byName.get(e.from) === from && byName.get(e.to) === to);
};

describe("API flow tracing (AST)", () => {
  test("resolves mount prefixes across files, including router.route chains", () => {
    expect(find("GET", "/api/users")).toBeDefined();
    expect(find("POST", "/api/users")).toBeDefined();
    expect(find("GET", "/api/users/:id")).toBeDefined();
    expect(find("DELETE", "/api/users/:id")).toBeDefined();
    expect(find("GET", "/health")).toBeDefined();
    expect(endpoints.every((e) => e.mountResolved)).toBe(true);
  });

  test("records middleware in execution order", () => {
    expect(find("POST", "/api/users").middleware).toEqual(["cors()", "express.json()", "authenticate", "validate(…)"]);
    expect(find("GET", "/health").middleware).toEqual(["cors()", "express.json()"]);
  });

  test("handler resolves through namespace import to its definition", () => {
    const ep = find("GET", "/api/users/:id");
    expect(ep.handlerFile).toBe("controllers/userController.js");
    expect(ep.confidence).toBe("high");
  });

  test("follows controller -> service instance -> model, only for calls that exist", () => {
    const t = traceEndpoint(project, find("POST", "/api/users"));
    const n = names(t);
    expect(edge(t, "create", "UserService.create")).toBeDefined();
    expect(edge(t, "UserService.create", "User.create")).toBeDefined();
    expect(edge(t, "UserService.create", "UserService.notify")).toBeDefined();
    expect(edge(t, "UserService.notify", "axios.post")).toBeDefined();
    expect(edge(t, "create", "logEvent")).toBeDefined();
    // Methods that the handler never calls must not appear
    expect(n.has("UserService.unused")).toBe(false);
    expect(n.has("UserService.findAll")).toBe(false);
  });

  test("captures response status codes and conditionality", () => {
    const t = traceEndpoint(project, find("GET", "/api/users/:id"));
    const r404 = t.nodes.find((x) => x.kind === "response" && x.status === 404);
    const r200 = t.nodes.find((x) => x.kind === "response" && x.status === 200 && x.filePath.includes("userController"));
    expect(r404).toBeDefined();
    expect(r200).toBeDefined();
    expect(t.edges.find((e) => e.to === r404.id).conditional).toBe(true);
    const del = traceEndpoint(project, find("DELETE", "/api/users/:id"));
    expect(del.nodes.some((x) => x.kind === "response" && x.status === 204)).toBe(true);
  });

  test("edges carry call-site line numbers", () => {
    const t = traceEndpoint(project, find("GET", "/api/users"));
    const e = edge(t, "list", "UserService.findAll");
    expect(e.lines).toEqual([4]);
  });

  test("node graph is JSON-serializable", () => {
    const t = traceEndpoint(project, find("POST", "/api/users"));
    expect(() => JSON.stringify(t)).not.toThrow();
    for (const e of t.edges) {
      expect(t.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(t.nodes.some((n) => n.id === e.to)).toBe(true);
    }
  });
});

describe("API flow tracing (Python / Flask)", () => {
  const pyProject = new Project(path.join(process.cwd(), "test-fixtures", "flask-app"));
  const pyEndpoints = discoverEndpointsInProject(pyProject);

  test("applies blueprint prefixes registered in another module", () => {
    const get = pyEndpoints.find((e) => e.method === "GET" && e.path === "/api/items/<int:item_id>");
    expect(get).toBeDefined();
    expect(get.mountResolved).toBe(true);
    expect(pyEndpoints.find((e) => e.method === "DELETE")).toBeDefined();
  });

  test("follows imported functions and detects responses", () => {
    const ep = pyEndpoints.find((e) => e.method === "GET");
    const t = traceEndpoint(pyProject, ep);
    const n = names(t);
    expect(n.has("load_item")).toBe(true);
    expect(edge(t, "get_item", "load_item")).toBeDefined();
    expect(t.nodes.some((x) => x.kind === "response" && x.status === 404)).toBe(true);
    expect(t.nodes.some((x) => x.kind === "response" && x.status === 200)).toBe(true);
    expect(t.nodes.some((x) => x.kind === "database" && x.name === "session.get")).toBe(true);
  });
});

describe("Flow evidence for explanations", () => {
  test("call edges record how the callee was imported, with the import line", () => {
    const t = traceEndpoint(project, find("POST", "/api/users"));
    const e = edge(t, "create", "UserService.create");
    expect(e.file).toBe("controllers/userController.js");
    expect(e.snippet).toBe("const user = await userService.create(req.body);");
    expect(e.via.kind).toBe("import");
    expect(e.via.spec).toBe("../services/userService.js");
    expect(e.via.importText).toBe('import userService from "../services/userService.js";');
    expect(edge(t, "UserService.create", "UserService.notify").via.kind).toBe("this-method");
  });

  test("middleware edges point at their registration line and level", () => {
    const t = traceEndpoint(project, find("POST", "/api/users"));
    const auth = t.edges.find((e) => e.kind === "next" && t.nodes.find((n) => n.id === e.to).name === "authenticate");
    expect(auth.file).toBe("app.js");
    expect(auth.snippet).toBe('app.use("/api/users", authenticate, userRoutes);');
    expect(auth.via.scope.level).toBe("app");
    const val = t.edges.find((e) => e.kind === "next" && t.nodes.find((n) => n.id === e.to).name === "validate(…)");
    expect(val.via.scope.level).toBe("route");
  });

  test("nodes carry their source signature and doc comment", () => {
    const t = traceEndpoint(project, find("GET", "/api/users/:id"));
    const n = t.nodes.find((x) => x.name === "UserService.findById");
    expect(n.signature).toBe("async findById(id) { return User.findById(id); }");
    expect(n.doc).toBe("Load a single user by its id.");
  });

  test("notes explain limitations without inventing problems", () => {
    const t = traceEndpoint(project, find("POST", "/api/users"));
    const ids = t.notes.map((x) => x.id);
    expect(ids).toContain("package-middleware");
    expect(ids).not.toContain("middleware-unresolved");
    expect(ids).not.toContain("no-response");
    expect(t.analysis.kind).toBe("static");
  });
});

describe("Python decorator middleware", () => {
  test("decorators below the route decorator become middleware steps before the view", () => {
    const pyProject = new Project(path.join(process.cwd(), "test-fixtures", "flask-app"));
    const ep = discoverEndpointsInProject(pyProject).find((e) => e.method === "GET");
    expect(ep.middleware).toEqual(["require_key"]);
    const t = traceEndpoint(pyProject, ep);
    const mw = t.nodes.find((n) => n.kind === "middleware");
    expect(mw.name).toBe("require_key");
    expect(mw.filePath).toBe("app/auth_helpers.py");
    expect(edge(t, "GET /api/items/<int:item_id>", "require_key").via.scope.level).toBe("decorator");
    expect(edge(t, "require_key", "get_item").kind).toBe("handles");
    // the decorator's own 401 abort is traced
    expect(t.nodes.some((n) => n.kind === "response" && n.status === 401)).toBe(true);
  });
});

describe("Analysis notes for incomplete flows", () => {
  const edgeProject = new Project(path.join(process.cwd(), "test-fixtures", "edge-cases"));
  const eps = discoverEndpointsInProject(edgeProject);

  test("a router that is never mounted is reported, not given an invented prefix", () => {
    const ep = eps.find((e) => e.path === "/jobs");
    expect(ep.mountResolved).toBe(false);
    const t = traceEndpoint(edgeProject, ep);
    expect(t.notes.map((n) => n.id)).toContain("mount-missing");
  });

  test("unresolved calls and runtime status codes are explained", () => {
    const t = traceEndpoint(edgeProject, eps.find((e) => e.path === "/jobs"));
    const ids = t.notes.map((n) => n.id);
    expect(ids).toContain("unresolved-calls");
    expect(ids).toContain("dynamic-status");
    const handler = t.nodes.find((n) => n.kind === "handler");
    expect(handler.unresolved.map((u) => u.label)).toContain("run");
    // nothing is drawn for the unknown call
    expect(t.nodes.some((n) => n.name === "run")).toBe(false);
  });

  test("a factory-produced handler is flagged instead of guessed", () => {
    const t = traceEndpoint(edgeProject, eps.find((e) => e.path === "/reports"));
    const ids = t.notes.map((n) => n.id);
    expect(ids).toContain("handler-unresolved");
    expect(t.nodes.find((n) => n.kind === "handler").resolution).toBe("unresolved");
  });
});
