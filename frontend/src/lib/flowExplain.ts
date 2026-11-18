/**
 * Plain-English explanations for API flow traces.
 *
 * Everything here is composed from facts the static analyzer recorded
 * (nodes, edges, call-site lines, import bindings, doc comments). Nothing is
 * invented: when a statement is an inference (e.g. "this middleware looks like
 * authentication" from its name), it is labelled as such via `basis`.
 */
import type { EdgeVia, FlowEdge, FlowNode, FlowTrace } from "./types";

/** A sentence made of text and clickable node references. */
export type Seg = string | { id: string; label: string };
export type Sentence = { segs: Seg[]; basis?: "code" | "name" | "convention"; conditional?: boolean; depth?: number };
export type Evidence = { label: string; file: string; line: number; text?: string | null };

const shortName = (n: FlowNode) => (n.kind === "endpoint" ? `${n.method} ${n.path}` : n.name);
const ref = (n: FlowNode | undefined): Seg => (n ? { id: n.id, label: shortName(n) } : "?");
const loc = (file?: string | null, line?: number | null) => (file ? `${file}${line ? `:${line}` : ""}` : "");

// ------------------------------------------------------------------ vocab

const MW_CATEGORIES: [RegExp, string][] = [
  [/limit|throttl|slow-?down/i, "rate limiting"],
  [/helmet|cors|xss|hpp|csrf|mongo-?sanitize|mongoSanitize/i, "security hardening"],
  [/auth|passport|jwt|protect|guard|verify|requireUser|isLoggedIn|login_required|permission|role/i, "authentication / authorization"],
  [/valid|celebrate|joi|zod|schema|check\b/i, "input validation"],
  [/json|urlencoded|bodyParser|body-parser|multer|upload|cookie|text\(|raw\(/i, "request parsing"],
  [/morgan|logger|logging|log\b|\.log|successHandler|errorHandler/i, "logging"],
  [/compress/i, "compression"],
  [/static|serve/i, "static files / docs"],
  [/session/i, "sessions"],
  [/cache/i, "caching"],
];

export function middlewareCategory(n: FlowNode): string | null {
  const hay = `${n.name} ${n.package || ""} ${n.factoryName || ""}`;
  for (const [re, cat] of MW_CATEGORIES) if (re.test(hay)) return cat;
  return null;
}

const READ_RE = /^(find|get|count|exists|aggregate|select|scalars?|fetch|paginate|distinct|populate|first|one|lean|query|all|read|load|search|list)/i;
const WRITE_RE = /^(create|insert|save|update|upsert|delete|destroy|remove|add|commit|merge|flush|bulk|set|incr|decr|del|push|truncate|replace|write|rollback)/i;

export function dataOp(n: FlowNode): "read" | "write" | "query" {
  const m = n.name.split(".").pop() || "";
  if (WRITE_RE.test(m)) return "write";
  if (READ_RE.test(m)) return m.toLowerCase() === "query" ? "query" : "read";
  return "query";
}

function dataTarget(n: FlowNode): string {
  if (n.model) return n.model;
  const parts = n.name.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : n.name;
}

/** "getUserByEmail" -> "get user by email" (used only as a labelled hint). */
export function nameAsWords(name: string): string | null {
  const last = name.split(".").pop() || name;
  if (!/[a-z][A-Z]|_/.test(last)) return null;
  return last.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
}

const METHOD_MEANING: Record<string, string> = {
  GET: "reads data without changing it", POST: "submits data or creates something", PUT: "replaces a resource", PATCH: "updates part of a resource",
  DELETE: "removes a resource", ALL: "matches every HTTP method", OPTIONS: "answers CORS pre-flight checks", HEAD: "checks a resource without a body",
};

const LAYER: Record<string, string> = {
  handler: "the route handler: the function the framework calls for this route",
  controller: "a controller-layer function",
  service: "a service: business logic kept separate from HTTP handling",
  data: "data-access code (model / repository) in this project",
  utility: "a helper / utility function",
  function: "a function in this project",
};

// ------------------------------------------------------------------ graph helpers

export type Graph = { byId: Map<string, FlowNode>; out: Map<string, FlowEdge[]>; inc: Map<string, FlowEdge[]> };

export function indexGraph(trace: FlowTrace): Graph {
  const byId = new Map(trace.nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  const inc = new Map<string, FlowEdge[]>();
  for (const e of trace.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
    if (!inc.has(e.to)) inc.set(e.to, []);
    inc.get(e.to)!.push(e);
  }
  for (const l of out.values()) l.sort((a, b) => a.order - b.order);
  return { byId, out, inc };
}

function statusText(n: FlowNode) {
  return n.status === "dynamic" ? "a runtime-chosen status" : `HTTP ${n.status}`;
}

/** One short sentence for "from does X to to" (used in lists and the walkthrough). */
export function edgeSentence(e: FlowEdge, g: Graph): Seg[] {
  const from = g.byId.get(e.from);
  const to = g.byId.get(e.to);
  if (!from || !to) return [];
  const at = e.lines.length ? ` at line ${e.lines.join(", ")}` : "";
  switch (e.kind) {
    case "next":
      return from.kind === "endpoint" ? ["The request first enters ", ref(to), " (middleware)"] : ["Then middleware ", ref(to), " runs"];
    case "handles":
      return ["The request reaches the handler ", ref(to)];
    case "calls":
      return [ref(from), " calls ", ref(to), at];
    case "queries":
      return [ref(from), ` ${dataOp(to) === "write" ? "writes to" : dataOp(to) === "read" ? "reads from" : "queries"} the database: `, ref(to), at];
    case "external":
      return [ref(from), ` calls out to ${to.category === "http" ? "an external HTTP service" : to.package || "an external package"}: `, ref(to), at];
    case "responds":
      return [ref(from), ` sends ${statusText(to)} back to the client`, at];
    case "error":
      return to.name.startsWith("throw") ? [ref(from), " can throw ", ref(to), to.status ? ` (HTTP ${to.status})` : "", at] : [ref(from), " forwards an error with ", ref(to), at];
    default:
      return [ref(from), " → ", ref(to)];
  }
}

// ------------------------------------------------------------------ why connected

export type EdgeExplanation = {
  title: string;
  sentences: Sentence[];
  evidence: Evidence[];
};

function viaSentences(via: EdgeVia | null | undefined, from: FlowNode, to: FlowNode): Sentence[] {
  if (!via) return [];
  switch (via.kind) {
    case "import": {
      const where = via.resolvedFile ? ` which resolves to ${via.resolvedFile}` : "";
      const def = to.filePath && via.resolvedFile && to.filePath !== via.resolvedFile ? ` (re-exported; the definition lives in ${to.filePath})` : "";
      return [{ segs: [`\`${via.local}\` is imported from '${via.spec}' on line ${via.importLine} of ${via.importFile}${where}${def}.`], basis: "code" }];
    }
    case "package":
      return [{ segs: [`\`${via.local}\` is imported from the package '${via.spec}' (line ${via.importLine}), so this call leaves your code.`], basis: "code" }];
    case "same-file":
      return [{ segs: [`\`${via.local}\` is defined in the same file, so the call resolves directly to it.`], basis: "code" }];
    case "instance":
      return [{ segs: [`\`${via.local}\` is an instance created with new ${via.className}() in this file, so the method is looked up on that class.`], basis: "code" }];
    case "this-method":
      return [{ segs: [`It is called through \`this\`, so it resolves to a method of the same class.`], basis: "code" }];
    case "instance-field":
      return [{ segs: [`It is called through \`this.${via.field}\`, which the class constructor assigns to a new instance; the method is looked up on that instance's class.`], basis: "code" }];
    case "local":
      return [{ segs: [`\`${via.local}\` is a function defined locally inside ${from.name} (line ${via.line}).`], basis: "code" }];
    case "middleware": {
      const sc = via.scope;
      if (!sc) return [];
      if (sc.level === "decorator") {
        return [{ segs: [ref(to), ` is applied as a decorator on the view function (between the route decorator and \`def\`), so it wraps the view and runs before its body${from.kind === "middleware" ? `, after ${shortName(from)} (decorators run top to bottom)` : ""}.`], basis: "code" }];
      }
      const how = sc.level === "route"
        ? "is passed as route-level middleware in the route definition, before the handler"
        : `is registered with ${sc.router}.use(${sc.prefix ? `'${sc.prefix}', …` : "…"})${sc.prefix ? `, so it applies to every request under ${sc.prefix}` : ", so it applies to every request that reaches this router"}`;
      const order = from.kind === "endpoint"
        ? "It is the first middleware registered on this request's path."
        : `It is registered after ${shortName(from)}, and Express runs middleware in registration order${from.callsNext ? `; ${shortName(from)} calls next() to continue` : ""}.`;
      return [{ segs: [ref(to), ` ${how}. ${order}`], basis: "code" }];
    }
    case "route": {
      const wrap = via.wrapper ? `, wrapped in ${via.wrapper}()` : "";
      const def = via.defFile ? ` It resolves to ${to.name} defined in ${via.defFile}.` : " The analyzer could not find its definition.";
      return [{ segs: [`The route definition passes \`${via.handlerLabel || "an inline function"}\` as its final handler${wrap}.${def}`], basis: "code" }];
    }
    case "decorator":
      return [{ segs: [`The route decorator above ${to.name} registers it as the view function for this URL.`], basis: "code" }];
    case "response":
      return [{ segs: [`\`${via.param}.${via.sender}()\` writes the HTTP response.${to.statusImplicit ? " No status was set, so the framework default (200) applies." : ""}`], basis: "code" }];
    case "next-error":
      return [{ segs: [`Calling \`${via.param}(error)\` skips the remaining handlers and jumps to Express error-handling middleware.`], basis: "code" }];
    case "throw":
      return [{ segs: [`The error propagates up to the caller; if nothing catches it, the framework's error handler turns it into the response.`], basis: "code" }];
    default:
      return [];
  }
}

export function explainEdge(e: FlowEdge, g: Graph): EdgeExplanation {
  const from = g.byId.get(e.from)!;
  const to = g.byId.get(e.to)!;
  const titles: Record<string, string> = {
    next: "Middleware order", handles: "Route → handler", calls: "Function call", queries: "Database operation",
    external: "External call", responds: "Response", error: "Error path",
  };
  const sentences: Sentence[] = [{ segs: edgeSentence(e, g), basis: "code" }];
  sentences.push(...viaSentences(e.via, from, to));
  if (e.conditional) sentences.push({ segs: ["This only happens on some paths: the line sits inside an if / try–catch / conditional expression."], basis: "code", conditional: true });
  if (e.count > 1) sentences.push({ segs: [`The same connection appears ${e.count} times (lines ${e.lines.join(", ")}).`], basis: "code" });
  if (e.async) sentences.push({ segs: ["The call is awaited, so the caller pauses until it finishes."], basis: "code" });
  if (e.id.startsWith("bypass:") || e.from.startsWith("group:") || e.to.startsWith("group:")) {
    sentences.push({ segs: ["(Display shortcut: grouped or hidden steps sit between these two nodes.)"] });
  }

  const evidence: Evidence[] = [];
  if (e.file && e.lines.length) evidence.push({ label: e.kind === "next" ? "Registered at" : e.kind === "handles" ? "Route defined at" : "Connection at", file: e.file, line: e.lines[0], text: e.snippet });
  const v = e.via;
  if (v && (v.kind === "import" || v.kind === "package") && v.importLine) evidence.push({ label: "Imported at", file: v.importFile, line: v.importLine, text: v.importText });
  if ((e.kind === "calls" || e.kind === "handles" || e.kind === "next") && to.filePath && to.line && to.resolution !== "unresolved" && !(e.file === to.filePath && e.lines[0] === to.line)) {
    evidence.push({ label: "Defined at", file: to.filePath, line: to.line, text: to.signature });
  }
  return { title: titles[e.kind] || "Connection", sentences, evidence };
}

// ------------------------------------------------------------------ node explanations

export type NodeExplanation = {
  what: Sentence[];
  why: Sentence[];
  evidence: Evidence[];
  confidence: { label: string; text: string; tone: "ok" | "info" | "warn" };
};

function effects(n: FlowNode, g: Graph): Sentence[] {
  const out = (g.out.get(n.id) || []).filter((e) => e.to !== n.id);
  const s: Sentence[] = [];
  const calls = out.filter((e) => e.kind === "calls");
  const db = out.filter((e) => e.kind === "queries");
  const ext = out.filter((e) => e.kind === "external");
  const res = out.filter((e) => e.kind === "responds");
  const err = out.filter((e) => e.kind === "error");
  const list = (es: FlowEdge[]) => es.flatMap((e, i) => [i ? ", " : "", ref(g.byId.get(e.to))]);
  if (calls.length) s.push({ segs: ["Calls ", ...list(calls), "."], basis: "code" });
  if (db.length) s.push({ segs: ["Touches the database: ", ...list(db), "."], basis: "code" });
  if (ext.length) s.push({ segs: ["Calls outside the app: ", ...list(ext), "."], basis: "code" });
  for (const e of res) {
    const r = g.byId.get(e.to)!;
    s.push({ segs: [e.conditional ? "Can respond " : "Responds ", `with ${statusText(r)} `, ref(r), ` (line ${e.lines.join(", ")})${e.conditional ? ", on some paths" : ""}.`], basis: "code", conditional: e.conditional });
  }
  for (const e of err) {
    const r = g.byId.get(e.to)!;
    s.push({ segs: [e.conditional ? "Can fail via " : "Fails via ", ref(r), r.status ? ` (HTTP ${r.status})` : "", "."], basis: "code", conditional: e.conditional });
  }
  if (n.callsNext) s.push({ segs: ["Calls next() to pass the request on."], basis: "code" });
  if (n.unresolved?.length) s.push({ segs: [`Also makes ${n.unresolved.length} call${n.unresolved.length === 1 ? "" : "s"} the analyzer could not follow (listed below).`], basis: "code" });
  return s;
}

export function explainNode(n: FlowNode, g: Graph, trace: FlowTrace): NodeExplanation {
  const what: Sentence[] = [];
  const add = (segs: Seg[], basis?: Sentence["basis"]) => what.push({ segs, basis });
  const fw = trace.endpoint.framework === "express" ? "Express" : trace.endpoint.framework === "fastapi" ? "FastAPI" : "Flask";

  switch (n.kind) {
    case "endpoint":
      add([`The entry point: ${fw} registers ${n.method} ${n.path} in ${loc(n.filePath, n.line)}. Every request to this URL starts here.`], "code");
      if (n.mountChain?.length) add([`The URL prefix comes from ${n.mountChain.map((m) => `'${m.prefix}' (${loc(m.file, m.line)})`).join(" then ")}.`], "code");
      break;
    case "middleware": {
      if (n.members) {
        add([`${n.members.length} middleware that run one after another and make no calls the analyzer could trace: ${n.detail}.`], "code");
        break;
      }
      const cat = middlewareCategory(n);
      const isPy = trace.endpoint.framework !== "express";
      if (n.package && n.factoryName && n.detail) add([`${n.detail} The package's own code is not traced.`], "code");
      else if (n.package) add([`${isPy ? "A decorator" : "Middleware"} from the ${isPy ? "Python" : "npm"} package '${n.package}'. Its code is not traced.`], "code");
      else if (n.factoryName) add([`Middleware created by calling ${n.factoryName}(). The analyzer traced the factory's body, which contains the returned middleware.`], "code");
      else if (n.resolution === "unresolved") add([`Registered as middleware, but the function behind it could not be found.`], "code");
      else if (isPy) add([`A decorator defined in this project. It wraps the view function, so it runs first and can stop the request early.`], "code");
      else add([`A middleware function in this project. It runs before the handler and can modify the request, stop it with a response, or pass it on with next().`], "code");
      if (cat) add([`Its name suggests ${cat}.`], "name");
      break;
    }
    case "database":
      add([`A database ${dataOp(n) === "query" ? "operation" : dataOp(n)} on ${dataTarget(n)}: \`${n.name}()\`.`], n.resolution === "pattern" ? "name" : "code");
      if (n.detail) add([n.detail + "."], "code");
      break;
    case "external":
      add([`${n.detail || "A call to code outside this project"}${n.package ? ` (package '${n.package}')` : ""}.`], "code");
      break;
    case "response":
      add([`Sends ${statusText(n)} to the client${n.sender ? ` using ${n.sender}()` : ""}${n.filePath ? ` in ${loc(n.filePath, n.line)}` : ""}.`], "code");
      if (n.statusImplicit) add([`No explicit status is set, so this relies on the framework default.`], "convention");
      break;
    case "error":
      add([n.detail || "An error path."], "code");
      break;
    default: {
      add([`This is ${LAYER[n.kind] || LAYER.function}${n.filePath ? `, in ${n.filePath}` : ""}.`], "code");
      if (n.wrapper) add([`It is wrapped in ${n.wrapper}(), which typically forwards thrown errors to the error handler.`], "convention");
    }
  }
  if (n.doc) add([`Doc comment: “${n.doc}”`], "code");
  else if (n.kind !== "endpoint" && n.kind !== "response" && n.kind !== "database" && !n.members) {
    const words = nameAsWords(n.name);
    if (words) add([`The name reads as “${words}”.`], "name");
  }
  if (n.kind !== "response") what.push(...effects(n, g));

  const why: Sentence[] = (g.inc.get(n.id) || [])
    .filter((e) => e.from !== n.id)
    .map((e) => ({ segs: whyIn(e, g), basis: "code" as const, conditional: e.conditional }));
  if (n.kind === "endpoint") why.push({ segs: ["It is the route you selected."], basis: "code" });

  const evidence: Evidence[] = [];
  if (n.filePath && n.line) evidence.push({ label: n.kind === "endpoint" ? "Route registered at" : n.kind === "response" || n.kind === "error" || n.kind === "external" ? "Happens at" : n.kind === "database" ? "Model / call at" : "Defined at", file: n.filePath, line: n.line, text: n.signature });

  const confidence =
    n.resolution === "resolved"
      ? { label: "Resolved", text: "Linked to an exact definition or statement in the source.", tone: "ok" as const }
      : n.resolution === "pattern"
        ? { label: "Pattern match", text: "Recognised from a well-known API shape (e.g. Model.find(), db.session.add()) rather than a resolved definition.", tone: "info" as const }
        : { label: "Unresolved", text: "Registered in the code, but the function behind it could not be found statically.", tone: "warn" as const };
  return { what, why, evidence, confidence };
}

function whyIn(e: FlowEdge, g: Graph): Seg[] {
  const from = g.byId.get(e.from)!;
  const at = e.file && e.lines.length ? ` (${loc(e.file, e.lines[0])})` : "";
  switch (e.kind) {
    case "next": return from.kind === "endpoint" ? ["It is the first middleware on this route's path", at, "."] : ["It is registered to run after ", ref(from), at, "."];
    case "handles": return ["The route definition names it as the handler", at, "."];
    case "calls": return [ref(from), " calls it", at, e.conditional ? ", on some paths" : "", "."];
    case "queries": return [ref(from), " performs it", at, "."];
    case "external": return [ref(from), " makes this call", at, "."];
    case "responds": return [ref(from), " sends it", at, e.conditional ? ", on some paths" : "", "."];
    case "error": return [ref(from), " raises it", at, e.conditional ? ", on some paths" : "", "."];
    default: return [ref(from), " leads here", at, "."];
  }
}

// ------------------------------------------------------------------ explain this API

export type ApiExplanation = {
  purpose: Sentence[];
  overview: Sentence[];
  journey: Sentence[];
  outcomes: { node: FlowNode; conditional: boolean; via: FlowNode | undefined }[];
  data: { reads: FlowNode[]; writes: FlowNode[]; other: FlowNode[]; external: FlowNode[] };
  caveat: Sentence | null;
};

/** Main request chain: endpoint → middleware… → handler. */
function mainChain(trace: FlowTrace, g: Graph): FlowNode[] {
  const chain: FlowNode[] = [];
  let cur: string | undefined = trace.entryId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = g.byId.get(cur);
    if (n) chain.push(n);
    const next: FlowEdge | undefined = (g.out.get(cur) || []).find((e) => e.kind === "next" || e.kind === "handles");
    cur = next?.to;
  }
  return chain;
}

export function explainEndpoint(trace: FlowTrace): ApiExplanation {
  const g = indexGraph(trace);
  const ep = trace.endpoint;
  const chain = mainChain(trace, g);
  const mws = chain.filter((n) => n.kind === "middleware");
  const handler = chain.find((n) => n.kind === "handler");

  // Purpose: doc comment if the code has one; otherwise HTTP convention + path.
  const segsPath = ep.path.split("/").filter(Boolean);
  const params = segsPath.filter((s) => /^[:{<]/.test(s)).map((s) => s.replace(/^[:{<](?:\w+:)?|[}>]$/g, ""));
  const words = segsPath.filter((s) => !/^[:{<]/.test(s) && !/^v\d+$/.test(s) && s !== "api").map((s) => s.replace(/[-_]/g, " "));
  const subject = words.length ? words.join(" / ") : "the root path";
  const purpose: Sentence[] = [];
  if (handler?.doc) purpose.push({ segs: [`The handler's doc comment says: “${handler.doc}”`], basis: "code" });
  purpose.push({
    segs: [`A ${ep.method} endpoint for “${subject}”${params.length ? `, addressed by ${params.map((p) => `\`${p}\``).join(" and ")}` : ""}. By HTTP convention, ${ep.method} ${METHOD_MEANING[ep.method] || "handles the request"}.`],
    basis: "convention",
  });

  const overview: Sentence[] = [];
  const fw = ep.framework === "express" ? "Express" : ep.framework === "fastapi" ? "FastAPI" : "Flask";
  overview.push({ segs: [`Registered with ${fw} in ${loc(ep.filePath, ep.startLine)}`, ep.mountChain?.length ? `, mounted under ${ep.mountChain.map((m) => m.prefix).join(" + ")}` : "", "."], basis: "code" });
  if (mws.length) {
    const cats = new Map<string, FlowNode[]>();
    const plain: FlowNode[] = [];
    for (const m of mws) {
      const c = middlewareCategory(m);
      if (c) {
        if (!cats.has(c)) cats.set(c, []);
        cats.get(c)!.push(m);
      } else plain.push(m);
    }
    const parts: Seg[] = [`Before the handler, the request passes through ${mws.length} middleware`];
    if (cats.size) {
      parts.push(", including ");
      [...cats.entries()].forEach(([c, ns], i) => {
        parts.push(i ? (i === cats.size - 1 ? " and " : ", ") : "", `${c} (`);
        ns.forEach((n, j) => parts.push(j ? ", " : "", ref(n)));
        parts.push(")");
      });
    }
    parts.push(".");
    overview.push({ segs: parts, basis: cats.size ? "name" : "code" });
  }
  if (handler) {
    overview.push({ segs: ["The work is done by the handler ", ref(handler), handler.resolution === "unresolved" ? ", whose body could not be found." : ` in ${loc(handler.filePath, handler.line)}.`], basis: "code" });
  }

  // Journey: depth-first from the handler (and middleware that do real work), in call order.
  const journey: Sentence[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (journey.length >= 14) return;
    for (const e of g.out.get(id) || []) {
      if (e.kind === "next" || e.kind === "handles" || e.to === id) continue;
      const to = g.byId.get(e.to);
      if (!to) continue;
      journey.push({ segs: edgeSentence(e, g), basis: "code", conditional: e.conditional, depth });
      if (!visited.has(e.to)) {
        visited.add(e.to);
        walk(e.to, depth + 1);
      }
    }
  };
  for (const m of mws) if ((g.out.get(m.id) || []).some((e) => e.kind !== "next" && e.kind !== "handles")) {
    journey.push({ segs: ["In middleware ", ref(m), ":"], basis: "code", depth: 0 });
    visited.add(m.id);
    walk(m.id, 1);
  }
  if (handler) {
    journey.push({ segs: ["In the handler ", ref(handler), ":"], basis: "code", depth: 0 });
    visited.add(handler.id);
    walk(handler.id, 1);
  }

  const outcomes = trace.nodes
    .filter((n) => n.kind === "response" || n.kind === "error")
    .map((n) => {
      const inc = g.inc.get(n.id) || [];
      return { node: n, conditional: inc.every((e) => e.conditional), via: g.byId.get(inc[0]?.from || "") };
    })
    .sort((a, b) => String(a.node.status ?? "zzz").localeCompare(String(b.node.status ?? "zzz")));

  const dbNodes = trace.nodes.filter((n) => n.kind === "database");
  const data = {
    reads: dbNodes.filter((n) => dataOp(n) === "read"),
    writes: dbNodes.filter((n) => dataOp(n) === "write"),
    other: dbNodes.filter((n) => dataOp(n) === "query"),
    external: trace.nodes.filter((n) => n.kind === "external"),
  };

  const did: Seg[] = [];
  const pushList = (label: string, list: FlowNode[]) => {
    if (!list.length) return;
    did.push(did.length ? "; " : "", label, " ");
    list.slice(0, 4).forEach((n, i) => did.push(i ? ", " : "", ref(n)));
    if (list.length > 4) did.push(` +${list.length - 4}`);
  };
  pushList("reads", data.reads);
  pushList("writes", data.writes);
  pushList("queries", data.other);
  pushList("calls out to", data.external);
  const codes = [...new Set(outcomes.filter((o) => o.node.kind === "response").map((o) => o.node.status))];
  const errs = outcomes.filter((o) => o.node.kind === "error").length;
  if (codes.length) did.push(did.length ? "; " : "", `responds ${codes.join(" / ")}`);
  if (errs) did.push(did.length ? "; " : "", `has ${errs} error path${errs > 1 ? "s" : ""}`);
  if (did.length) purpose.push({ segs: ["In the code, this endpoint ", ...did, "."], basis: "code" });

  const warnNotes = (trace.notes || []).filter((x) => x.severity === "warn");
  const caveat: Sentence | null = warnNotes.length
    ? { segs: [`Some of the flow could not be determined statically (${warnNotes.map((x) => x.title.toLowerCase()).join("; ")}). See Analysis notes.`], basis: "code" }
    : null;
  return { purpose, overview, journey, outcomes, data, caveat };
}

// ------------------------------------------------------------------ walkthrough

export type Phase = "request" | "middleware" | "handler" | "logic" | "data" | "external" | "response" | "error";
export type WalkStep = { node: FlowNode; edge: FlowEdge | null; depth: number; phase: Phase; sentence: Seg[] };

export const PHASE_LABEL: Record<Phase, string> = {
  request: "Request arrives", middleware: "Middleware", handler: "Handler", logic: "Business logic",
  data: "Data access", external: "External services", response: "Response", error: "Error path",
};

function phaseOf(n: FlowNode): Phase {
  switch (n.kind) {
    case "endpoint": return "request";
    case "middleware": return "middleware";
    case "handler": return "handler";
    case "database": return "data";
    case "external": return "external";
    case "response": return "response";
    case "error": return "error";
    default: return "logic";
  }
}

/** Depth-first walk in call order, each node once, with a sentence per step. */
export function buildWalkthrough(trace: FlowTrace, limit = 300): WalkStep[] {
  const g = indexGraph(trace);
  const steps: WalkStep[] = [];
  const seen = new Set<string>();
  const visit = (id: string, edge: FlowEdge | null, depth: number) => {
    if (steps.length >= limit || seen.has(id)) return;
    const node = g.byId.get(id);
    if (!node) return;
    seen.add(id);
    const sentence: Seg[] = edge ? edgeSentence(edge, g) : [`A ${node.method} request for ${node.path} arrives and matches the route in ${loc(node.filePath, node.line)}`];
    steps.push({ node, edge, depth, phase: phaseOf(node), sentence });
    for (const e of g.out.get(id) || []) {
      if (e.to === id) continue;
      visit(e.to, e, e.kind === "next" || e.kind === "handles" ? depth : depth + 1);
    }
  };
  visit(trace.entryId, null, 0);
  return steps;
}
