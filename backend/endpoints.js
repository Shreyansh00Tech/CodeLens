/**
 * Endpoint Discovery and API Flow Tracing
 *
 * Static analysis built on the Babel AST (JS/TS) plus a line-oriented scanner
 * for Python (Flask / FastAPI). Everything reported here is derived from the
 * source: a relationship is only drawn when the analyzer can point at the
 * exact line that creates it. Anything it cannot resolve is reported as
 * "unresolved" instead of being guessed.
 *
 * Supported (JS/TS): Express / Express.Router / router-compatible APIs
 *   - app.METHOD(path, ...handlers), router.route(path).METHOD(...)
 *   - app.use(prefix?, ...middleware|router) mounting, across files
 *   - ESM + CommonJS imports, re-exports, module.exports objects
 *   - function declarations, arrow functions, object literals, classes,
 *     class instances (`new Service()`), `this.method()` calls
 * Supported (Python): @x.route / @x.get|post|... decorators, Blueprint /
 *   APIRouter prefixes, same-file and `from x import y` call resolution.
 */
import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default || traverseModule;

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".cache",
  "__pycache__", ".venv", "venv", "vendor", "out",
]);
const JS_RE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;
const PY_RE = /\.py$/;
const MAX_FILE_BYTES = 800_000;
const MAX_FILES = 6000;

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);
const ROUTER_NAME_RE = /^(app|server|router|api|routes?|[a-z][A-Za-z0-9]*Router|[a-z][A-Za-z0-9]*Routes)$/;
const RESPONSE_SENDERS = new Set(["json", "send", "sendStatus", "sendFile", "render", "redirect", "end", "download", "jsonp"]);
const DB_METHODS = new Set([
  "find", "findOne", "findById", "findByIdAndUpdate", "findByIdAndDelete", "findOneAndUpdate", "findOneAndDelete",
  "findAll", "findByPk", "findAndCountAll", "findMany", "findUnique", "findFirst", "findUniqueOrThrow", "findFirstOrThrow",
  "create", "createMany", "insert", "insertOne", "insertMany", "save", "update", "updateOne", "updateMany", "upsert",
  "delete", "deleteOne", "deleteMany", "destroy", "remove", "aggregate", "count", "countDocuments", "exists",
  "query", "execute", "raw", "bulkCreate", "distinct", "populate",
]);
const DB_ROOTS = new Set(["db", "pool", "knex", "prisma", "sequelize", "client", "connection", "conn", "redis", "mongoose"]);

const PKG_CATEGORIES = [
  [/^(mongoose|mongodb|sequelize|@prisma\/client|prisma|pg|mysql2?|knex|typeorm|drizzle-orm|better-sqlite3|sqlite3|objection|@supabase\/supabase-js|firebase-admin)/, "database"],
  [/^(redis|ioredis|node-cache|memcached)/, "cache"],
  [/^(axios|node-fetch|got|superagent|undici|request|ky)$/, "http"],
  [/^(jsonwebtoken|bcrypt|bcryptjs|passport|argon2|jose)/, "auth"],
  [/^(nodemailer|@sendgrid|twilio|stripe|@aws-sdk|aws-sdk|openai|@anthropic-ai|cloudinary)/, "service"],
  [/^(amqplib|kafkajs|bull|bullmq)/, "queue"],
  [/^(fs|fs-extra|fs\/promises|node:fs)$/, "filesystem"],
];

function categorizePackage(pkg) {
  for (const [re, cat] of PKG_CATEGORIES) if (re.test(pkg)) return cat;
  return "library";
}

// ------------------------------------------------------------------
// Project: file list + lazily parsed modules
// ------------------------------------------------------------------

export class Project {
  constructor(root) {
    this.root = root;
    this.files = [];
    this.fileSet = new Set();
    this.modules = new Map();
    this.contents = new Map();
    this.truncatedFiles = false;
    this.walk(root);
  }

  walk(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (IGNORE.has(item.name) || item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) this.walk(full);
      else if (item.isFile() && (JS_RE.test(item.name) || PY_RE.test(item.name)) && !/\.d\.ts$/.test(item.name) && !/\.min\.js$/.test(item.name)) {
        if (this.files.length >= MAX_FILES) { this.truncatedFiles = true; return; }
        const rel = path.relative(this.root, full).replace(/\\/g, "/");
        this.files.push(rel);
        this.fileSet.add(rel);
      }
    }
  }

  read(rel) {
    if (this.contents.has(rel)) return this.contents.get(rel);
    let text = null;
    try {
      const full = path.join(this.root, rel);
      if (fs.statSync(full).size <= MAX_FILE_BYTES) text = fs.readFileSync(full, "utf8");
    } catch {
      text = null;
    }
    this.contents.set(rel, text);
    return text;
  }

  module(rel) {
    if (!rel || !JS_RE.test(rel)) return null;
    if (this.modules.has(rel)) return this.modules.get(rel);
    this.modules.set(rel, null); // guard against re-entrancy
    const text = this.read(rel);
    const mod = text == null ? null : buildModule(this, rel, text);
    this.modules.set(rel, mod);
    return mod;
  }

  resolveImport(fromRel, spec) {
    if (!spec || !(spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("src/"))) return null;
    let base;
    if (spec.startsWith("@/") || spec.startsWith("~/")) base = path.posix.join("src", spec.slice(2));
    else if (spec.startsWith("src/")) base = spec;
    else base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    const stripped = base.replace(/\.(m?js|cjs|jsx|ts|tsx)$/, "");
    const cands = [base];
    for (const ext of [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"]) cands.push(stripped + ext);
    for (const ext of [".js", ".ts", ".tsx", ".jsx"]) cands.push(`${stripped}/index${ext}`);
    for (const c of cands) if (this.fileSet.has(c)) return c;
    return null;
  }
}

function lineOf(node) {
  return node?.loc?.start?.line || 0;
}
function endLineOf(node) {
  return node?.loc?.end?.line || lineOf(node);
}
function isFn(n) {
  return n && (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression" || n.type === "ObjectMethod" || n.type === "ClassMethod" || n.type === "ClassPrivateMethod");
}
function strValue(n) {
  if (!n) return null;
  if (n.type === "StringLiteral") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked).join("");
  return null;
}
function propName(member) {
  if (!member) return null;
  const p = member.property || member.key;
  if (!p) return null;
  if (!member.computed && (p.type === "Identifier" || p.type === "PrivateName")) return p.name || p.id?.name;
  if (p.type === "StringLiteral") return p.value;
  return null;
}
function isRequire(n) {
  return n && n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && n.arguments.length === 1 && n.arguments[0].type === "StringLiteral";
}
function unwrapTS(n) {
  while (n && (n.type === "TSAsExpression" || n.type === "TSNonNullExpression" || n.type === "TypeCastExpression" || n.type === "ParenthesizedExpression" || n.type === "AwaitExpression" || n.type === "TSSatisfiesExpression")) n = n.expression || n.argument;
  return n;
}

/** Render a short readable label for an expression used as a handler argument. */
function exprLabel(n) {
  n = unwrapTS(n);
  if (!n) return "?";
  if (n.type === "Identifier") return n.name;
  if (n.type === "ThisExpression") return "this";
  if (n.type === "MemberExpression" || n.type === "OptionalMemberExpression") return `${exprLabel(n.object)}.${propName(n) || "[…]"}`;
  if (n.type === "CallExpression") return `${exprLabel(n.callee)}(${n.arguments.length ? "…" : ""})`;
  if (n.type === "NewExpression") return `new ${exprLabel(n.callee)}(${n.arguments.length ? "…" : ""})`;
  if (isFn(n)) return n.id?.name ? n.id.name : "inline handler";
  return n.type;
}

// ------------------------------------------------------------------
// Module model
// ------------------------------------------------------------------

function fnDef(mod, fnPath, name, extra = {}) {
  const node = fnPath.node;
  return {
    key: `${mod.rel}#${name}@${lineOf(node)}`,
    name,
    file: mod.rel,
    line: lineOf(node),
    endLine: endLineOf(node),
    async: !!node.async,
    params: node.params.map((p) => (p.type === "Identifier" ? p.name : p.type === "AssignmentPattern" && p.left.type === "Identifier" ? p.left.name : p.type === "ObjectPattern" ? "{…}" : p.type === "RestElement" ? `...${p.argument.name || ""}` : "…")),
    path: fnPath,
    lang: "js",
    ...extra,
  };
}

/** Wrappers like asyncHandler(fn), catchAsync(fn), wrap(fn): return the inner function path. */
function innerFnPath(p) {
  let cur = p;
  for (let i = 0; i < 3 && cur; i++) {
    const n = unwrapTS(cur.node);
    if (isFn(n)) return { fnPath: cur.node === n ? cur : cur.get("expression"), wrappers: i };
    if (n?.type === "CallExpression") {
      const args = cur.get("arguments");
      const fnArg = args.find((a) => isFn(a.node));
      if (!fnArg) return null;
      cur = fnArg;
      continue;
    }
    return null;
  }
  return null;
}

function buildModule(project, rel, text) {
  let ast;
  try {
    ast = parse(text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["typescript", "jsx", "decorators-legacy", "classProperties", "classPrivateProperties", "classPrivateMethods", "dynamicImport", "topLevelAwait"],
    });
  } catch {
    return null;
  }
  const mod = {
    rel,
    ast,
    imports: new Map(), // local -> { file|null, pkg|null, imported: 'default'|'*'|name }
    defs: new Map(), // name -> fnDef
    classes: new Map(), // name -> { name, line, methods: Map, superName, ctorAssigns: Map }
    objects: new Map(), // name -> { props: Map(prop -> node path) }
    instances: new Map(), // name -> className expression label (Identifier name)
    values: new Map(), // name -> init node (other top-level values)
    exports: new Map(), // exported -> { local } | { file, imported }
    starExports: [],
    cjsDefault: null, // local name or { objectPath } for module.exports = ...
    routerVars: new Set(),
    isModelFile: /mongoose\.model\s*\(|\bmodel\s*\(\s*['"`]|sequelize\.define\s*\(|\.define\s*\(\s*['"`]|extends\s+Model\b|@Entity\s*\(|new\s+Schema\s*\(|pgTable\s*\(|mongoose\.Schema/.test(text),
    programPath: null,
  };

  let stmtLine = 0; // line of the top-level statement being registered (import evidence)
  const addImport = (local, spec, imported) => {
    const file = project.resolveImport(rel, spec);
    mod.imports.set(local, { file, pkg: file ? null : spec, imported, spec, line: stmtLine });
  };

  const registerClass = (cPath, name) => {
    const node = cPath.node;
    const cls = { name, line: lineOf(node), endLine: endLineOf(node), methods: new Map(), superName: node.superClass?.type === "Identifier" ? node.superClass.name : null, ctorAssigns: new Map() };
    for (const m of cPath.get("body.body")) {
      const mn = m.node;
      if ((mn.type === "ClassMethod" || mn.type === "ClassPrivateMethod") && mn.kind !== "get" && mn.kind !== "set") {
        const mName = propName(mn) || mn.key?.id?.name;
        if (!mName) continue;
        if (mName === "constructor") {
          // this.x = new Y()  /  this.x = y (constructor injection is unresolvable, skip)
          m.traverse({
            AssignmentExpression(a) {
              const l = a.node.left;
              const r = unwrapTS(a.node.right);
              if (l.type === "MemberExpression" && l.object.type === "ThisExpression" && r?.type === "NewExpression" && r.callee.type === "Identifier") {
                cls.ctorAssigns.set(propName(l), r.callee.name);
              }
            },
          });
          continue;
        }
        cls.methods.set(mName, fnDef(mod, m, `${name}.${mName}`, { className: name, isStatic: !!mn.static }));
      } else if (mn.type === "ClassProperty" && mn.value) {
        const pName = propName(mn);
        const v = unwrapTS(mn.value);
        if (pName && isFn(v)) cls.methods.set(pName, fnDef(mod, m.get("value"), `${name}.${pName}`, { className: name, isStatic: !!mn.static }));
        else if (pName && v?.type === "NewExpression" && v.callee.type === "Identifier") cls.ctorAssigns.set(pName, v.callee.name);
      }
    }
    mod.classes.set(name, cls);
  };

  const registerDeclarator = (dPath) => {
    const id = dPath.node.id;
    const init = unwrapTS(dPath.node.init);
    if (!init) return;
    if (id.type === "Identifier") {
      const name = id.name;
      if (isRequire(init)) {
        addImport(name, init.arguments[0].value, "*");
        return;
      }
      if (init.type === "MemberExpression" && isRequire(init.object) && propName(init)) {
        addImport(name, init.object.arguments[0].value, propName(init));
        return;
      }
      const inner = innerFnPath(dPath.get("init"));
      if (inner) {
        mod.defs.set(name, fnDef(mod, inner.fnPath, name, { wrapped: inner.wrappers > 0 }));
        return;
      }
      if (init.type === "ClassExpression") {
        registerClass(dPath.get("init"), name);
        return;
      }
      if (init.type === "ObjectExpression") {
        const props = new Map();
        for (const pp of dPath.get("init.properties")) {
          const k = propName(pp.node);
          if (!k) continue;
          if (pp.node.type === "ObjectMethod") props.set(k, pp);
          else if (pp.node.type === "ObjectProperty") props.set(k, pp.get("value"));
        }
        mod.objects.set(name, { props, line: lineOf(init) });
        return;
      }
      if (init.type === "NewExpression" && init.callee.type === "Identifier") {
        mod.instances.set(name, init.callee.name);
        if (init.callee.name === "Router") mod.routerVars.add(name);
        return;
      }
      if (init.type === "CallExpression") {
        const c = init.callee;
        const cl = exprLabel(c);
        if (/^(express|express\.Router|Router|express\(\)\.Router|fastify|Fastify|createRouter|new Router|koaRouter)$/.test(cl) || (c.type === "Identifier" && c.name === "Router")) {
          mod.routerVars.add(name);
        }
      }
      mod.values.set(name, init);
    } else if (id.type === "ObjectPattern") {
      const src = isRequire(init) ? init.arguments[0].value : null;
      if (!src) return;
      for (const p of id.properties) {
        if (p.type === "ObjectProperty" && p.value.type === "Identifier") addImport(p.value.name, src, propName(p) || p.value.name);
      }
    }
  };

  traverse(ast, {
    Program(pp) {
      mod.programPath = pp;
      for (const st of pp.get("body")) {
        stmtLine = lineOf(st.node);
        let s = st;
        const n = s.node;
        if (n.type === "ImportDeclaration") {
          if (n.importKind === "type") continue;
          for (const sp of n.specifiers) {
            if (sp.type === "ImportDefaultSpecifier") addImport(sp.local.name, n.source.value, "default");
            else if (sp.type === "ImportNamespaceSpecifier") addImport(sp.local.name, n.source.value, "*");
            else if (sp.type === "ImportSpecifier") addImport(sp.local.name, n.source.value, sp.imported.name || sp.imported.value);
          }
          continue;
        }
        if (n.type === "ExportAllDeclaration") {
          const f = project.resolveImport(rel, n.source.value);
          if (f) mod.starExports.push(f);
          continue;
        }
        if (n.type === "ExportNamedDeclaration") {
          if (n.source) {
            const f = project.resolveImport(rel, n.source.value);
            for (const sp of n.specifiers) {
              const exported = sp.exported.name || sp.exported.value;
              if (f) mod.exports.set(exported, { file: f, imported: sp.local?.name || "default" });
            }
            continue;
          }
          for (const sp of n.specifiers || []) mod.exports.set(sp.exported.name || sp.exported.value, { local: sp.local.name });
          if (!n.declaration) continue;
          s = st.get("declaration");
        }
        if (n.type === "ExportDefaultDeclaration") {
          const d = st.get("declaration");
          const dn = d.node;
          if (dn.type === "Identifier") mod.exports.set("default", { local: dn.name });
          else if (dn.type === "FunctionDeclaration" || dn.type === "ClassDeclaration") {
            const nm = dn.id?.name || "default";
            if (dn.type === "FunctionDeclaration") mod.defs.set(nm, fnDef(mod, d, nm));
            else registerClass(d, nm);
            mod.exports.set("default", { local: nm });
          } else if (isFn(dn) || dn.type === "CallExpression") {
            const inner = innerFnPath(d);
            if (inner) {
              mod.defs.set("default", fnDef(mod, inner.fnPath, "default"));
              mod.exports.set("default", { local: "default" });
            }
          } else if (dn.type === "ObjectExpression") {
            const props = new Map();
            for (const p of d.get("properties")) {
              const k = propName(p.node);
              if (!k) continue;
              props.set(k, p.node.type === "ObjectMethod" ? p : p.get("value"));
            }
            mod.objects.set("default", { props, line: lineOf(dn) });
            mod.exports.set("default", { local: "default" });
          } else if (dn.type === "NewExpression" && dn.callee.type === "Identifier") {
            mod.instances.set("default", dn.callee.name);
            mod.exports.set("default", { local: "default" });
          }
          continue;
        }
        const sn = s.node;
        const exported = st.node.type === "ExportNamedDeclaration";
        if (sn.type === "FunctionDeclaration" && sn.id) {
          mod.defs.set(sn.id.name, fnDef(mod, s, sn.id.name));
          if (exported) mod.exports.set(sn.id.name, { local: sn.id.name });
        } else if (sn.type === "ClassDeclaration" && sn.id) {
          registerClass(s, sn.id.name);
          if (exported) mod.exports.set(sn.id.name, { local: sn.id.name });
        } else if (sn.type === "VariableDeclaration") {
          for (const d of s.get("declarations")) {
            registerDeclarator(d);
            if (exported && d.node.id.type === "Identifier") mod.exports.set(d.node.id.name, { local: d.node.id.name });
          }
        } else if (sn.type === "ExpressionStatement" && sn.expression.type === "AssignmentExpression") {
          const left = sn.expression.left;
          const rightPath = s.get("expression.right");
          const right = unwrapTS(rightPath.node);
          const isModExports = left.type === "MemberExpression" && left.object.type === "Identifier" && left.object.name === "module" && propName(left) === "exports";
          const isExportsProp = left.type === "MemberExpression" && ((left.object.type === "Identifier" && left.object.name === "exports") || (left.object.type === "MemberExpression" && left.object.object.type === "Identifier" && left.object.object.name === "module" && propName(left.object) === "exports"));
          if (isModExports) {
            if (right.type === "Identifier") mod.cjsDefault = right.name;
            else if (right.type === "ObjectExpression") {
              const props = new Map();
              for (const p of rightPath.get("properties")) {
                const k = propName(p.node);
                if (!k) continue;
                props.set(k, p.node.type === "ObjectMethod" ? p : p.get("value"));
              }
              mod.objects.set("module.exports", { props, line: lineOf(right) });
              mod.cjsDefault = "module.exports";
            } else if (right.type === "NewExpression" && right.callee.type === "Identifier") {
              mod.instances.set("module.exports", right.callee.name);
              mod.cjsDefault = "module.exports";
            } else if (right.type === "ClassExpression") {
              registerClass(rightPath, right.id?.name || "module.exports");
              mod.cjsDefault = right.id?.name || "module.exports";
            } else {
              const inner = innerFnPath(rightPath);
              if (inner) {
                const nm = right.id?.name || "module.exports";
                mod.defs.set(nm, fnDef(mod, inner.fnPath, nm));
                mod.cjsDefault = nm;
              }
            }
          } else if (isExportsProp) {
            const k = propName(left);
            if (!k) continue;
            if (isRequire(right)) {
              const f = project.resolveImport(rel, right.arguments[0].value);
              if (f) mod.exports.set(k, { file: f, imported: "*" });
              else mod.imports.set(k, { file: null, pkg: right.arguments[0].value, imported: "*" });
            } else if (right.type === "Identifier") mod.exports.set(k, { local: right.name });
            else {
              const inner = innerFnPath(rightPath);
              if (inner) {
                mod.defs.set(k, fnDef(mod, inner.fnPath, k));
                mod.exports.set(k, { local: k });
              }
            }
          }
        }
      }
      pp.stop();
    },
  });
  if (mod.cjsDefault && !mod.exports.has("default")) mod.exports.set("default", { local: mod.cjsDefault, cjs: true });
  return mod;
}

// ------------------------------------------------------------------
// Symbol resolution
// ------------------------------------------------------------------
// A Target is one of:
//   { type: 'fn', def }                       a concrete function definition
//   { type: 'class', file, cls }              a class (static method access)
//   { type: 'instance', file, cls }           an instance of a class
//   { type: 'object', file, obj, name }       an object literal of members
//   { type: 'module', file }                  a namespace / CJS module object
//   { type: 'value', file, name, model }      some other project value (models)
//   { type: 'package', pkg, member }          an npm/builtin package binding

function resolveLocal(project, mod, name, depth = 0) {
  if (!mod || depth > 12) return null;
  if (mod.defs.has(name)) return { type: "fn", def: mod.defs.get(name) };
  if (mod.classes.has(name)) return { type: "class", file: mod.rel, cls: mod.classes.get(name) };
  if (mod.objects.has(name)) return { type: "object", file: mod.rel, obj: mod.objects.get(name), name };
  if (mod.instances.has(name)) {
    const cls = resolveLocal(project, mod, mod.instances.get(name), depth + 1);
    if (cls?.type === "class") return { type: "instance", file: cls.file, cls: cls.cls };
    if (cls?.type === "package") return { type: "package", pkg: cls.pkg, member: cls.member };
    return null;
  }
  if (mod.imports.has(name)) {
    const imp = mod.imports.get(name);
    if (!imp.file) return { type: "package", pkg: imp.pkg, member: imp.imported === "*" || imp.imported === "default" ? null : imp.imported };
    const target = project.module(imp.file);
    if (imp.imported === "*") {
      if (!target) return { type: "module", file: imp.file };
      // CommonJS require() of a module that assigns module.exports = X → X itself
      if (target.cjsDefault) return resolveExport(project, target, "default", depth + 1) || { type: "module", file: imp.file };
      return { type: "module", file: imp.file };
    }
    return resolveExport(project, target, imp.imported, depth + 1) || (target?.isModelFile ? { type: "value", file: imp.file, name, model: true } : null);
  }
  if (mod.values.has(name)) return { type: "value", file: mod.rel, name, model: mod.isModelFile };
  return null;
}

function resolveExport(project, mod, exported, depth = 0) {
  if (!mod || depth > 12) return null;
  if (exported === "*") return mod.cjsDefault ? resolveLocal(project, mod, mod.cjsDefault, depth + 1) || { type: "module", file: mod.rel } : { type: "module", file: mod.rel };
  const e = mod.exports.get(exported);
  if (e) {
    if (e.file) return resolveExport(project, project.module(e.file), e.imported, depth + 1);
    return resolveLocal(project, mod, e.local, depth + 1);
  }
  // CommonJS: require('./x').foo where module.exports = { foo }
  if (exported !== "default" && mod.cjsDefault) {
    const d = resolveLocal(project, mod, mod.cjsDefault, depth + 1);
    const m = d ? resolveMember(project, d, exported, depth + 1) : null;
    if (m) return m;
  }
  if (exported === "default" && mod.cjsDefault) return resolveLocal(project, mod, mod.cjsDefault, depth + 1);
  for (const f of mod.starExports) {
    const r = resolveExport(project, project.module(f), exported, depth + 1);
    if (r) return r;
  }
  return null;
}

function classMethod(project, file, cls, name, depth = 0) {
  let curFile = file;
  let cur = cls;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.methods.has(name)) return { type: "fn", def: cur.methods.get(name) };
    if (!cur.superName) return null;
    const sup = resolveLocal(project, project.module(curFile), cur.superName, depth + 1);
    if (sup?.type !== "class") return null;
    curFile = sup.file;
    cur = sup.cls;
  }
  return null;
}

function resolveMember(project, target, prop, depth = 0) {
  if (!target || !prop || depth > 12) return null;
  switch (target.type) {
    case "module":
      return resolveExport(project, project.module(target.file), prop, depth + 1);
    case "class":
    case "instance":
      return classMethod(project, target.file, target.cls, prop, depth);
    case "object": {
      const vp = target.obj.props.get(prop);
      if (!vp) return null;
      const mod = project.module(target.file);
      if (vp.node.type === "ObjectMethod") return { type: "fn", def: fnDef(mod, vp, `${target.name === "module.exports" || target.name === "default" ? path.posix.basename(target.file).replace(/\.\w+$/, "") : target.name}.${prop}`) };
      const v = unwrapTS(vp.node);
      if (v?.type === "Identifier") return resolveLocal(project, mod, v.name, depth + 1);
      const inner = innerFnPath(vp);
      if (inner) return { type: "fn", def: fnDef(mod, inner.fnPath, `${target.name === "module.exports" || target.name === "default" ? path.posix.basename(target.file).replace(/\.\w+$/, "") : target.name}.${prop}`) };
      if (v?.type === "MemberExpression" && v.object.type === "Identifier") {
        const base = resolveLocal(project, mod, v.object.name, depth + 1);
        return resolveMember(project, base, propName(v), depth + 1);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Resolve an expression (callee or handler argument) evaluated at `exprPath`
 * inside module `mod`. `ctx.className` enables `this.method()` resolution.
 */
function resolveExpr(project, mod, exprPath, ctx = {}) {
  const n = unwrapTS(exprPath.node);
  if (!n) return null;
  if (n.type === "Identifier") {
    const binding = exprPath.scope.getBinding(n.name);
    if (binding && binding.kind !== "module" && binding.scope.block.type !== "Program") {
      // Local binding inside a function
      const bp = binding.path;
      if (bp.isFunctionDeclaration()) return { type: "fn", def: fnDef(mod, bp, n.name, { local: true }) };
      if (bp.isVariableDeclarator()) {
        const init = unwrapTS(bp.node.init);
        if (init?.type === "NewExpression" && init.callee.type === "Identifier") {
          const cls = resolveExpr(project, mod, bp.get("init.callee"), ctx);
          if (cls?.type === "class") return { type: "instance", file: cls.file, cls: cls.cls };
          if (cls?.type === "package") return cls;
        }
        const inner = innerFnPath(bp.get("init"));
        if (inner) return { type: "fn", def: fnDef(mod, inner.fnPath, n.name, { local: true }) };
        if (init?.type === "Identifier" || init?.type === "MemberExpression") return resolveExpr(project, mod, bp.get("init"), ctx);
      }
      return null; // parameter or otherwise dynamic
    }
    return resolveLocal(project, mod, n.name);
  }
  if (n.type === "MemberExpression" || n.type === "OptionalMemberExpression") {
    const prop = propName(n);
    const obj = unwrapTS(n.object);
    if (obj.type === "ThisExpression" && ctx.className) {
      const cls = mod.classes.get(ctx.className);
      return cls ? classMethod(project, mod.rel, cls, prop) : null;
    }
    // this.service.method()
    if (obj.type === "MemberExpression" && unwrapTS(obj.object).type === "ThisExpression" && ctx.className) {
      const cls = mod.classes.get(ctx.className);
      const clsName = cls?.ctorAssigns.get(propName(obj));
      if (clsName) {
        const c = resolveLocal(project, mod, clsName);
        if (c?.type === "class") return resolveMember(project, { type: "instance", file: c.file, cls: c.cls }, prop);
      }
      return null;
    }
    const base = resolveExpr(project, mod, exprPath.get("object"), ctx);
    if (!base) return null;
    if (base.type === "package") return { type: "package", pkg: base.pkg, member: [base.member, prop].filter(Boolean).join(".") };
    if (base.type === "value") return { ...base, member: prop };
    return resolveMember(project, base, prop);
  }
  if (isFn(n)) return { type: "fn", def: fnDef(mod, exprPath.node === n ? exprPath : exprPath.get("expression"), n.id?.name || "inline handler", { inline: true }) };
  if (n.type === "CallExpression") {
    // Wrapper such as asyncHandler(controller.fn) or catchAsync(async () => {...})
    for (const a of exprPath.get("arguments")) {
      const an = unwrapTS(a.node);
      if (isFn(an) || an.type === "Identifier" || an.type === "MemberExpression") {
        const r = resolveExpr(project, mod, a, ctx);
        if (r?.type === "fn") return { ...r, wrapper: exprLabel(n.callee) };
      }
    }
    return { type: "factory", label: exprLabel(n), callee: resolveExpr(project, mod, exprPath.get("callee"), ctx) };
  }
  return null;
}

// ------------------------------------------------------------------
// Endpoint discovery (JS/TS)
// ------------------------------------------------------------------

/** Find the root object + chain for router.route('/x').get(h).post(h). */
function routeChainRoot(calleeObj) {
  let cur = calleeObj;
  while (cur && cur.type === "CallExpression" && cur.callee.type === "MemberExpression") {
    if (propName(cur.callee) === "route") return { routerNode: cur.callee.object, pathNode: cur.arguments[0] };
    if (!ROUTE_METHODS.has(propName(cur.callee))) return null;
    cur = cur.callee.object;
  }
  return null;
}

/**
 * `routes.forEach((r) => router.use(r.path, r.route))` over a literal array of
 * objects is expanded into one argument list per element. Anything not
 * statically known is returned unchanged.
 */
function expandLoopUse(cp, args) {
  const params = new Map();
  for (const a of args) {
    const n = a.node;
    if (n.type !== "MemberExpression" || n.object.type !== "Identifier") return [args];
    params.set(n.object.name, true);
  }
  if (params.size !== 1) return [args];
  const paramName = [...params.keys()][0];
  const binding = cp.scope.getBinding(paramName);
  if (!binding || binding.kind !== "param") return [args];
  const fnPath = binding.path.isFunction() ? binding.path : binding.path.parentPath;
  if (!fnPath?.isFunction() || fnPath.node.params[0]?.name !== paramName) return [args];
  const loopCall = fnPath.parentPath;
  if (!loopCall?.isCallExpression() || loopCall.node.callee.type !== "MemberExpression" || !/^(forEach|map)$/.test(propName(loopCall.node.callee))) return [args];
  const arrNode = loopCall.node.callee.object;
  if (arrNode.type !== "Identifier") return [args];
  const arrBinding = loopCall.scope.getBinding(arrNode.name);
  const init = arrBinding?.path.isVariableDeclarator() ? arrBinding.path.get("init") : null;
  if (!init || !init.isArrayExpression()) return [args];
  const out = [];
  for (const el of init.get("elements")) {
    if (!el.isObjectExpression()) return [args];
    const props = new Map();
    for (const p of el.get("properties")) if (p.isObjectProperty()) props.set(propName(p.node), p.get("value"));
    const list = args.map((a) => props.get(propName(a.node)));
    if (list.some((x) => !x)) return [args];
    out.push(list);
  }
  return out.length ? out : [args];
}

function isRouterIdent(mod, node) {
  if (!node || node.type !== "Identifier") return false;
  return mod.routerVars.has(node.name) || ROUTER_NAME_RE.test(node.name);
}

function scanRouters(project, rel) {
  const mod = project.module(rel);
  if (!mod) return null;
  const routers = new Map(); // routerVar -> { routes: [], uses: [] }
  const get = (name) => {
    if (!routers.has(name)) routers.set(name, { name, file: rel, routes: [], uses: [], isApp: false });
    return routers.get(name);
  };
  for (const v of mod.routerVars) {
    const init = mod.values.get(v);
    const r = get(v);
    if (init?.type === "CallExpression" && init.callee.type === "Identifier" && /^(express|fastify|Fastify)$/.test(init.callee.name)) r.isApp = true;
  }

  traverse(mod.ast, {
    CallExpression(cp) {
      const n = cp.node;
      if (n.callee.type !== "MemberExpression") return;
      const method = propName(n.callee);
      if (!method) return;
      const obj = n.callee.object;

      if (ROUTE_METHODS.has(method)) {
        let routerName = null;
        let paths = [];
        let argOffset = 1;
        if (isRouterIdent(mod, obj)) {
          routerName = obj.name;
          const a0 = n.arguments[0];
          if (a0?.type === "ArrayExpression") paths = a0.elements.map(strValue).filter((s) => s != null);
          else if (strValue(a0) != null) paths = [strValue(a0)];
          // app.get('setting') with one arg reads a setting; not a route
          if (n.arguments.length < 2) return;
        } else if (obj.type === "CallExpression") {
          const root = routeChainRoot(obj);
          if (!root || !isRouterIdent(mod, root.routerNode)) return;
          routerName = root.routerNode.name;
          const p = strValue(root.pathNode);
          if (p != null) paths = [p];
          argOffset = 0;
        } else return;
        paths = paths.filter((p) => p.startsWith("/") || p === "*" || /^[\w:.*-]/.test(p)).filter((p) => !/\s/.test(p));
        if (!paths.length) return;
        const args = cp.get("arguments").slice(argOffset);
        if (!args.length) return;
        for (const p of paths) {
          get(routerName).routes.push({
            method: method.toUpperCase(),
            path: p.startsWith("/") || p === "*" ? p : "/" + p,
            line: lineOf(n),
            endLine: endLineOf(n),
            args,
            file: rel,
          });
        }
        return;
      }

      if (method === "use" && isRouterIdent(mod, obj)) {
        const args = cp.get("arguments");
        for (const expanded of expandLoopUse(cp, args)) {
          let prefix = null;
          let rest = expanded;
          const a0 = expanded[0]?.node;
          if (a0 && strValue(a0) != null) {
            prefix = strValue(a0);
            rest = expanded.slice(1);
          } else if (a0 && expanded.length >= 2 && (a0.type === "MemberExpression" || a0.type === "Identifier") && !isFn(a0)) {
            // router.use(somePath, somethingElse) with a non-literal path: the prefix is dynamic.
            const r = resolveExpr(project, mod, expanded[0]);
            if (!r || r.type === "value") {
              get(obj.name).dynamicUses = (get(obj.name).dynamicUses || 0) + 1;
              continue;
            }
          }
          get(obj.name).uses.push({ prefix, args: rest, line: lineOf(n), file: rel });
        }
      }
    },
  });

  // Which local router does this file export?
  let exported = null;
  const def = mod.exports.get("default");
  if (def?.local && routers.has(def.local)) exported = def.local;
  const named = new Map();
  for (const [ex, e] of mod.exports) if (e.local && routers.has(e.local)) named.set(ex, e.local);
  return { rel, mod, routers, exported, named };
}

/** Resolve an app.use() argument to a router { file, name } if it is one. */
function resolveRouterRef(project, scans, scan, argPath) {
  const n = unwrapTS(argPath.node);
  if (!n) return null;
  if (n.type === "Identifier") {
    if (scan.routers.has(n.name) && scan.routers.get(n.name).routes.length + scan.routers.get(n.name).uses.length > 0) return { file: scan.rel, name: n.name };
    const imp = scan.mod.imports.get(n.name);
    if (imp?.file) return exportedRouter(project, scans, imp.file, imp.imported);
    return null;
  }
  if (isRequire(n)) {
    const f = project.resolveImport(scan.rel, n.arguments[0].value);
    return f ? exportedRouter(project, scans, f, "default") : null;
  }
  if (n.type === "MemberExpression" && n.object.type === "Identifier") {
    const imp = scan.mod.imports.get(n.object.name);
    if (imp?.file) return exportedRouter(project, scans, imp.file, propName(n));
  }
  return null;
}

function exportedRouter(project, scans, file, imported, depth = 0) {
  if (depth > 5) return null;
  const s = scans.get(file);
  if (!s) return null;
  if ((imported === "default" || imported === "*") && s.exported) return { file, name: s.exported };
  if (s.named.has(imported)) return { file, name: s.named.get(imported) };
  // re-export: export { default as users } from './users'
  const e = s.mod.exports.get(imported === "*" ? "default" : imported);
  if (e?.file) return exportedRouter(project, scans, e.file, e.imported, depth + 1);
  if (e?.local && s.mod.imports.has(e.local)) {
    const imp = s.mod.imports.get(e.local);
    if (imp.file) return exportedRouter(project, scans, imp.file, imp.imported, depth + 1);
  }
  return null;
}

function joinPaths(prefix, p) {
  const a = (prefix || "").replace(/\/+$/, "");
  const b = p === "/" ? "" : p;
  const joined = (a + (b.startsWith("/") || !b ? b : "/" + b)) || "/";
  return joined.replace(/\/{2,}/g, "/");
}

function middlewareRef(project, scan, argPath, useLine, scope = null) {
  const label = exprLabel(argPath.node);
  return { label, file: scan.rel, line: lineOf(argPath.node) || useLine, argPath, scanRel: scan.rel, scope };
}

function discoverJsEndpoints(project) {
  const candidates = project.files.filter((f) => JS_RE.test(f)).filter((f) => {
    const t = project.read(f);
    return t && /\.(get|post|put|patch|delete|all|options|head|use|route)\s*\(/.test(t) && /\b(express|Router|router|app)\b/.test(t);
  });
  const scans = new Map();
  for (const f of candidates) {
    const s = scanRouters(project, f);
    if (s && s.routers.size) scans.set(f, s);
  }

  // Build mount edges: parent router -> child router with prefix + middleware
  const mountsInto = new Map(); // childKey -> [{ parentKey, prefix, middleware, line, file }]
  const routerKey = (file, name) => `${file}::${name}`;
  for (const scan of scans.values()) {
    for (const r of scan.routers.values()) {
      r.globalMiddleware = [];
      for (const use of r.uses) {
        const mws = [];
        let mounted = false;
        for (const a of use.args) {
          const child = resolveRouterRef(project, scans, scan, a);
          if (child && !(child.file === scan.rel && child.name === r.name)) {
            mounted = true;
            const ck = routerKey(child.file, child.name);
            if (!mountsInto.has(ck)) mountsInto.set(ck, []);
            mountsInto.get(ck).push({ parentKey: routerKey(scan.rel, r.name), prefix: use.prefix || "/", middleware: [...mws], line: use.line, file: scan.rel });
          } else {
            mws.push(middlewareRef(project, scan, a, use.line, { level: r.isApp ? "app" : "router", router: r.name, prefix: use.prefix || null }));
          }
        }
        if (!mounted) r.globalMiddleware.push({ prefix: use.prefix, line: use.line, middleware: mws });
      }
    }
  }

  const allRouters = new Map();
  for (const scan of scans.values()) for (const r of scan.routers.values()) allRouters.set(routerKey(scan.rel, r.name), { r, scan });

  // Expand each router's mount chains (all distinct paths from a root)
  const chainsCache = new Map();
  const chainsFor = (key, seen = new Set()) => {
    if (chainsCache.has(key)) return chainsCache.get(key);
    if (seen.has(key)) return [];
    seen.add(key);
    const parents = mountsInto.get(key) || [];
    let chains = [];
    if (!parents.length) chains = [{ prefix: "", hops: [], middleware: [], mounted: allRouters.get(key)?.r.isApp || false }];
    for (const m of parents) {
      const parent = allRouters.get(m.parentKey);
      for (const pc of chainsFor(m.parentKey, seen)) {
        // Path-less or path-scoped app.use() registered before this mount
        const inherited = (parent?.r.globalMiddleware || [])
          .filter((g) => g.line < m.line)
          .flatMap((g) => g.middleware.map((mw) => ({ mw, scope: g.prefix ? joinPaths(pc.prefix, g.prefix) : null })));
        const mountScope = joinPaths(pc.prefix, m.prefix);
        chains.push({
          prefix: mountScope,
          hops: [...pc.hops, { file: m.file, line: m.line, prefix: m.prefix }],
          middleware: [...pc.middleware, ...inherited, ...m.middleware.map((mw) => ({ mw, scope: mountScope }))],
          mounted: true,
        });
        if (chains.length > 8) break;
      }
    }
    seen.delete(key);
    chainsCache.set(key, chains);
    return chains;
  };

  const endpoints = [];
  for (const [key, { r, scan }] of allRouters) {
    if (!r.routes.length) continue;
    const chains = chainsFor(key);
    for (const chain of chains.length ? chains : [{ prefix: "", hops: [], middleware: [], mounted: false }]) {
      for (const route of r.routes) {
        const fullPath = joinPaths(chain.prefix, route.path);
        const applies = (scope) => !scope || scope === "/" || fullPath === scope || fullPath.startsWith(scope.replace(/\/+$/, "") + "/");
        const local = r.globalMiddleware
          .filter((g) => g.line < route.line && applies(g.prefix ? joinPaths(chain.prefix, g.prefix) : null))
          .flatMap((g) => g.middleware);
        const inheritedMws = chain.middleware.filter((x) => applies(x.scope)).map((x) => x.mw);
        const routeMws = route.args.slice(0, -1).map((a) => middlewareRef(project, scan, a, route.line, { level: "route", router: r.name, prefix: null }));
        const handlerArg = route.args[route.args.length - 1];
        const handlerTarget = resolveExpr(project, scan.mod, handlerArg);
        const handlerLabel = exprLabel(handlerArg.node);
        const resolved = handlerTarget?.type === "fn";
        endpoints.push({
          id: `${route.method} ${fullPath} @${route.file}:${route.line}`,
          framework: "express",
          method: route.method,
          path: fullPath,
          routePath: route.path,
          handler: handlerLabel === "inline handler" ? null : handlerLabel,
          handlerFile: resolved ? handlerTarget.def.file : null,
          handlerLine: resolved ? handlerTarget.def.line : null,
          filePath: route.file,
          startLine: route.line,
          endLine: route.endLine,
          middleware: [...inheritedMws, ...local, ...routeMws].map((m) => m.label),
          mountChain: chain.hops,
          mountResolved: chain.mounted || chain.hops.length > 0,
          confidence: resolved ? "high" : "low",
          _internal: { handlerArg, middleware: [...inheritedMws, ...local, ...routeMws], scanRel: scan.rel },
        });
      }
    }
  }
  return endpoints;
}

// ------------------------------------------------------------------
// Python (Flask / FastAPI)
// ------------------------------------------------------------------

function pyIndent(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, "    ").length : 0;
}

function pyModule(project, rel) {
  const key = `py:${rel}`;
  if (project.modules.has(key)) return project.modules.get(key);
  const text = project.read(rel);
  if (text == null) {
    project.modules.set(key, null);
    return null;
  }
  const lines = text.split("\n");
  const defs = new Map(); // name -> def (top-level functions + Class.method)
  const imports = new Map(); // local -> { file|null, pkg, imported }
  let curClass = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ind = pyIndent(line);
    const cm = line.match(/^class\s+([A-Za-z_]\w*)/);
    if (cm) { curClass = { name: cm[1], indent: 0 }; continue; }
    if (curClass && ind === 0 && line.trim() && !line.trim().startsWith("#") && !line.trim().startsWith("@")) curClass = null;
    const dm = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)/);
    if (dm) {
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (pyIndent(lines[j]) <= ind) break;
        end = j;
      }
      const name = ind > 0 && curClass ? `${curClass.name}.${dm[2]}` : ind === 0 ? dm[2] : null;
      if (name) {
        defs.set(name, {
          key: `${rel}#${name}@${i + 1}`, name, file: rel, line: i + 1, endLine: end + 1,
          async: /async\s+def/.test(line), params: dm[3].split(",").map((s) => s.trim().split(/[:=]/)[0].trim()).filter(Boolean),
          lang: "py", className: ind > 0 ? curClass?.name : undefined,
        });
      }
    }
    const fm = line.match(/^\s*from\s+([.\w]+)\s+import\s+\(?([^#]+)/);
    if (fm) {
      const file = resolvePy(project, rel, fm[1]);
      for (const part of fm[2].replace(/[()\\]/g, "").split(",")) {
        const [orig, alias] = part.trim().split(/\s+as\s+/);
        if (!orig) continue;
        const sub = resolvePy(project, rel, `${fm[1]}${fm[1].endsWith(".") ? "" : "."}${orig}`);
        imports.set((alias || orig).trim(), sub ? { file: sub, pkg: null, imported: "*", spec: `${fm[1]}.${orig.trim()}`, line: i + 1 } : { file, pkg: file ? null : fm[1], imported: orig.trim(), spec: fm[1], line: i + 1 });
      }
    }
    const im = line.match(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
    if (im) {
      const file = resolvePy(project, rel, im[1]);
      imports.set(im[2] || im[1].split(".")[0], { file, pkg: file ? null : im[1], imported: "*", spec: im[1], line: i + 1 });
    }
  }
  const classes = new Set([...text.matchAll(/^class\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]));
  const bases = new Map([...text.matchAll(/^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)].map((m) => [m[1], m[2].split(",").map((b) => b.trim().split(".").pop()).filter(Boolean)]));
  const mod = { rel, lines, defs, imports, text, classes, bases };
  project.modules.set(key, mod);
  return mod;
}

/**
 * Resolve a Python decorator name such as `login_required`, `auth.check` or
 * `token_auth.login_required` to a project function or to the package object
 * it comes from (`token_auth = HTTPTokenAuth()` → flask_httpauth).
 */
function resolvePyDecorator(project, rel, name) {
  const mod = pyModule(project, rel);
  if (!mod) return null;
  const parts = name.split(".");
  if (parts.length === 1 && mod.defs.has(name)) return { def: mod.defs.get(name) };
  const imp = mod.imports.get(parts[0]);
  if (!imp) return null;
  if (!imp.file) return { pkg: imp.pkg };
  const tm = pyModule(project, imp.file);
  if (!tm) return null;
  if (parts.length === 1) return tm.defs.has(imp.imported) ? { def: tm.defs.get(imp.imported) } : null;
  if (imp.imported === "*" && tm.defs.has(parts[1])) return { def: tm.defs.get(parts[1]) };
  const varName = imp.imported === "*" ? parts[1] : imp.imported;
  const lineIdx = tm.lines.findIndex((l) => new RegExp(`^${varName}\\s*=\\s*([\\w.]+)\\s*\\(`).test(l));
  if (lineIdx < 0) return null;
  const ctor = tm.lines[lineIdx].match(/=\s*([\w.]+)\s*\(/)[1];
  const ci = tm.imports.get(ctor.split(".")[0]);
  return { pkg: ci && !ci.file ? ci.pkg : null, factory: `${ctor}()`, file: imp.file, line: lineIdx + 1 };
}

/** Look up Class.method in a Python module, following base classes defined in the same module. */
function pyMethod(mod, cls, prop, depth = 0) {
  if (!mod || depth > 6) return null;
  const d = mod.defs.get(`${cls}.${prop}`);
  if (d) return d;
  for (const b of mod.bases?.get(cls) || []) {
    const r = pyMethod(mod, b, prop, depth + 1);
    if (r) return r;
  }
  return null;
}

function resolvePy(project, fromRel, spec) {
  const dots = spec.match(/^\.*/)[0].length;
  const parts = spec.slice(dots).split(".").filter(Boolean);
  const bases = [];
  if (dots) {
    let d = path.posix.dirname(fromRel);
    for (let i = 1; i < dots; i++) d = path.posix.dirname(d);
    bases.push(d === "." ? "" : d);
  } else {
    bases.push("");
    let d = path.posix.dirname(fromRel);
    while (d && d !== ".") { bases.push(d); d = path.posix.dirname(d); }
  }
  for (const b of bases) {
    const p = path.posix.join(b, ...parts);
    if (project.fileSet.has(p + ".py")) return p + ".py";
    if (project.fileSet.has(p + "/__init__.py")) return p + "/__init__.py";
  }
  return null;
}

function discoverPyEndpoints(project) {
  const endpoints = [];
  const pyFiles = project.files.filter((f) => PY_RE.test(f));
  // Blueprint / APIRouter objects: "file::var" -> own prefix
  const routerDefs = new Map();
  // Registrations: "file::var" -> prefix given at register/include time
  const registered = new Map();
  const keyFor = (mod, name) => {
    if (routerDefs.has(`${mod.rel}::${name}`)) return `${mod.rel}::${name}`;
    const imp = mod.imports.get(name);
    if (imp?.file) return `${imp.file}::${imp.imported}`;
    return null;
  };
  for (const rel of pyFiles) {
    const text = project.read(rel);
    if (!text || !/Blueprint|APIRouter/.test(text)) continue;
    for (const m of text.matchAll(/^(\w+)\s*=\s*(?:\w+\.)?(Blueprint|APIRouter)\s*\(([^)]*)\)/gm)) {
      const pm = m[3].match(/(?:url_prefix|prefix)\s*=\s*['"]([^'"]*)['"]/);
      routerDefs.set(`${rel}::${m[1]}`, pm ? pm[1] : "");
    }
  }
  for (const rel of pyFiles) {
    const text = project.read(rel);
    if (!text || !/register_blueprint|include_router/.test(text)) continue;
    const mod = pyModule(project, rel);
    for (const m of text.matchAll(/\.(?:register_blueprint|include_router)\s*\(\s*([\w.]+)([^)]*)\)/g)) {
      const pm = m[2].match(/(?:url_prefix|prefix)\s*=\s*['"]([^'"]*)['"]/);
      const name = m[1].split(".").pop();
      let key = keyFor(mod, m[1].includes(".") ? m[1].split(".")[0] : name);
      // `from app.api import bp` resolves the module; `routes.bp` style resolves through it
      if (key && m[1].includes(".")) key = `${key.split("::")[0]}::${name}`;
      if (key) registered.set(key, pm ? pm[1] : "");
    }
  }
  for (const rel of pyFiles) {
    const text = project.read(rel);
    if (!text || !/@\s*\w+\.(route|get|post|put|patch|delete|api_route)\s*\(/.test(text)) continue;
    const mod = pyModule(project, rel);
    const prefixFor = (obj) => {
      const key = keyFor(mod, obj);
      if (!key) return { prefix: "", resolved: obj === "app" };
      // An imported Blueprint whose module is a package __init__ that re-imports it
      const own = routerDefs.get(key) ?? "";
      const reg = registered.get(key);
      return { prefix: joinPaths(reg ?? "", own || "/").replace(/\/$/, "") || "", resolved: reg !== undefined };
    };
    const lines = mod.lines;
    for (let i = 0; i < lines.length; i++) {
      const dm = lines[i].match(/^\s*@\s*(\w+)\.(route|get|post|put|patch|delete|api_route)\s*\(\s*['"]([^'"]*)['"]([^)]*)\)?/);
      if (!dm) continue;
      const [, obj, kind, rawPath, rest] = dm;
      let methods = [kind === "route" || kind === "api_route" ? "GET" : kind.toUpperCase()];
      const mm = (rest || "").match(/methods\s*=\s*[[(]([^\])]*)[\])]/);
      if (mm) methods = mm[1].split(",").map((s) => s.trim().replace(/['"]/g, "").toUpperCase()).filter(Boolean);
      let def = null;
      // Decorators between the route decorator and `def` wrap the registered view, so they run first (top to bottom).
      const decorators = [];
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const fm = lines[j].match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/);
        if (fm) { def = mod.defs.get(fm[1]) || null; break; }
        const dec = lines[j].match(/^\s*@\s*([A-Za-z_][\w.]*)\s*(\(.*)?$/);
        if (dec && !/\.(route|get|post|put|patch|delete|api_route)$/.test(dec[1])) decorators.push({ label: dec[1] + (dec[2] ? "(…)" : ""), name: dec[1], line: j + 1 });
        if (lines[j].trim() && !lines[j].trim().startsWith("@") && !lines[j].trim().startsWith("#")) break;
      }
      const pre = prefixFor(obj);
      const fullPath = joinPaths(pre.prefix, rawPath.startsWith("/") ? rawPath : "/" + rawPath);
      for (const method of methods) {
        endpoints.push({
          id: `${method} ${fullPath} @${rel}:${i + 1}`,
          framework: /APIRouter|FastAPI/.test(text) ? "fastapi" : "flask",
          method,
          path: fullPath,
          routePath: rawPath,
          handler: def?.name || null,
          handlerFile: def ? rel : null,
          handlerLine: def?.line || null,
          filePath: rel,
          startLine: i + 1,
          endLine: def?.endLine || i + 2,
          middleware: decorators.map((d) => d.label),
          mountChain: [],
          mountResolved: pre.resolved,
          confidence: def ? "high" : "low",
          _internal: { pyDef: def, pyDecorators: decorators, pyFile: rel },
        });
      }
    }
  }
  return endpoints;
}

// ------------------------------------------------------------------
// Public: discovery
// ------------------------------------------------------------------

export function discoverEndpointsInProject(project) {
  let js = [];
  let py = [];
  try { js = discoverJsEndpoints(project); } catch (e) { console.error("JS endpoint discovery failed:", e.message); }
  try { py = discoverPyEndpoints(project); } catch (e) { console.error("Python endpoint discovery failed:", e.message); }
  const seen = new Set();
  const out = [];
  for (const ep of [...js, ...py]) {
    if (seen.has(ep.id)) continue;
    seen.add(ep.id);
    out.push(ep);
  }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return out;
}

/** Strip internal AST references so the endpoint can be sent as JSON. */
export function publicEndpoint(ep) {
  if (!ep) return ep;
  const { _internal, ...rest } = ep;
  return rest;
}

export function discoverEndpoints(sourceDir) {
  return discoverEndpointsInProject(new Project(sourceDir)).map(publicEndpoint);
}

// ------------------------------------------------------------------
// Flow tracing
// ------------------------------------------------------------------

function layerFor(file) {
  const f = file.toLowerCase();
  if (/(^|\/)(controllers?|handlers?)(\/|\.|$)|controller/.test(f)) return "controller";
  if (/(^|\/)services?(\/|\.|$)|service/.test(f)) return "service";
  if (/(repositor|(^|\/)repos?(\/|$)|dao|(^|\/)models?(\/|\.|$)|(^|\/)db(\/|\.|$)|(^|\/)data(\/|$)|schema|entit)/.test(f)) return "data";
  if (/middlewares?|guards?|(^|\/)auth/.test(f)) return "middleware";
  if (/(utils?|helpers?|lib)(\/|\.|$)/.test(f)) return "utility";
  return "function";
}

class FlowBuilder {
  constructor(project, opts) {
    this.project = project;
    this.maxDepth = opts.maxDepth ?? 8;
    this.maxNodes = opts.maxNodes ?? 160;
    this.nodes = new Map();
    this.edges = new Map();
    this.order = 0;
    this.truncated = false;
    this.unresolvedTotal = 0;
    this.expanded = new Set();
  }

  addNode(n) {
    if (this.nodes.has(n.id)) return this.nodes.get(n.id);
    if (this.nodes.size >= this.maxNodes) {
      this.truncated = true;
      this.nodeLimitHit = true;
      return null;
    }
    const node = { depth: 0, ...n };
    this.nodes.set(n.id, node);
    return node;
  }

  addEdge(from, to, kind, meta = {}) {
    if (!from || !to) return;
    const id = `${from}->${to}:${kind}`;
    const e = this.edges.get(id);
    if (e) {
      e.count += 1;
      if (meta.line && !e.lines.includes(meta.line)) e.lines.push(meta.line);
      return;
    }
    this.edges.set(id, {
      id, from, to, kind, order: ++this.order, count: 1, lines: meta.line ? [meta.line] : [], label: meta.label || null,
      conditional: !!meta.conditional, async: !!meta.async,
      // Where the connecting line of code lives (the caller's file unless stated)
      file: meta.file || this.nodes.get(from)?.filePath || null,
      via: meta.via || null,
    });
  }

  fnNode(def, kindOverride) {
    const id = `fn:${def.key}`;
    return this.addNode({
      id,
      kind: kindOverride || layerFor(def.file),
      name: def.name,
      filePath: def.file,
      line: def.line,
      endLine: def.endLine,
      async: def.async,
      params: def.params,
      wrapper: def.wrapper || null,
      inline: !!def.inline,
      resolution: "resolved",
      doc: docFor(this.project, def),
    });
  }

  traceDef(def, nodeId, depth, ctxRes) {
    if (this.expanded.has(nodeId)) return;
    this.expanded.add(nodeId);
    const node = this.nodes.get(nodeId);
    if (depth >= this.maxDepth) {
      node.truncated = "max-depth";
      this.truncated = true;
      return;
    }
    if (def.lang === "py") return this.tracePy(def, nodeId, depth);
    const mod = this.project.module(def.file);
    if (!mod || !def.path) return;
    const resName = this.resParamName(def, ctxRes);
    const unresolved = [];
    const libraryCalls = new Set();
    const calls = [];
    const fnPath = def.path;
    const self = this;

    const throws = [];
    fnPath.traverse({
      ThrowStatement(tp) { throws.push(tp); },
      CallExpression(cp) { calls.push(cp); },
      OptionalCallExpression(cp) { calls.push(cp); },
      NewExpression(cp) { calls.push(cp); },
    });
    calls.sort((a, b) => (a.node.start ?? 0) - (b.node.start ?? 0));

    for (const cp of calls) {
      const n = cp.node;
      const callee = unwrapTS(n.callee);
      const line = lineOf(n);
      const isConditional = isConditionalCall(cp, fnPath);

      // Response helpers: res.json(...), res.status(404).send(...)
      if (callee.type === "MemberExpression" && RESPONSE_SENDERS.has(propName(callee))) {
        const root = memberRoot(callee);
        if (root?.type === "Identifier" && isResponseBinding(cp, root.name, resName)) {
          const status = responseStatus(callee, n);
          const sender = propName(callee);
          const rid = `res:${nodeId}:${status.code}:${sender}`;
          const rn = this.addNode({ id: rid, kind: "response", name: `${status.code} ${sender === "sendStatus" ? "status" : sender}`, status: status.code, statusImplicit: status.implicit, sender, filePath: def.file, line, resolution: "resolved", depth: depth + 1 });
          if (rn) this.addEdge(nodeId, rid, "responds", { line, conditional: isConditional, file: def.file, via: { kind: "response", sender: propName(callee), param: root.name } });
          continue;
        }
      }
      // Intermediate chain links (res.status(…), User.find().lean()): the inner call is visited separately.
      if (callee.type === "MemberExpression" && unwrapTS(callee.object).type === "CallExpression") continue;
      if (callee.type === "Identifier" && /^(next|done|cb|callback)$/.test(callee.name) && cp.scope.getBinding(callee.name)?.kind === "param") {
        if (n.arguments.length > 0) {
          const nn = this.addNode({ id: `err:${nodeId}`, kind: "error", name: `${callee.name}(${exprLabel(n.arguments[0])})`, filePath: def.file, line, resolution: "resolved", depth: depth + 1, detail: "Forwards an error to the Express error-handling middleware." });
          if (nn) this.addEdge(nodeId, nn.id, "error", { line, conditional: isConditional, file: def.file, via: { kind: "next-error", param: callee.name } });
        } else node.callsNext = true;
        continue;
      }
      if (callee.type === "Identifier" && /^(require|console|setTimeout|setInterval|parseInt|parseFloat|Number|String|Boolean|Array|Object|Promise|Error|Date|JSON|Math|Symbol|Map|Set|RegExp|BigInt|URL|isNaN|encodeURIComponent|decodeURIComponent)$/.test(callee.name)) continue;
      if (callee.type === "MemberExpression") {
        const r = memberRoot(callee);
        if (r?.type === "Identifier" && /^(console|JSON|Math|Object|Array|Promise|Date|Number|String|process|Buffer|Reflect|path)$/.test(r.name) && !cp.scope.getBinding(r.name)) continue;
      }

      const target = resolveExpr(this.project, mod, cp.get("callee"), { className: def.className });
      if (target?.type === "fn") {
        if (target.def.key === def.key) {
          this.addEdge(nodeId, nodeId, "calls", { line, label: "recursive" });
          continue;
        }
        const child = this.fnNode(target.def);
        if (!child) continue;
        child.depth = Math.min(child.depth || Infinity, depth + 1);
        this.addEdge(nodeId, child.id, "calls", { line, conditional: isConditional, async: n.type !== "NewExpression" && cp.parentPath.isAwaitExpression(), file: def.file, via: callVia(mod, cp, callee, target.def) });
        const passesRes = resName && n.arguments.some((a) => a.type === "Identifier" && a.name === resName) ? n.arguments.findIndex((a) => a.type === "Identifier" && a.name === resName) : -1;
        this.traceDef(target.def, child.id, depth + 1, passesRes >= 0 ? { index: passesRes } : null);
        continue;
      }
      if (target?.type === "package" || (callee.type === "Identifier" && callee.name === "fetch" && !cp.scope.getBinding("fetch"))) {
        const pkg = target?.pkg || "fetch";
        const cat = pkg === "fetch" ? "http" : categorizePackage(pkg);
        const label = exprLabel(callee);
        if (cat === "library") { libraryCalls.add(label); continue; }
        const kind = cat === "database" || cat === "cache" ? "database" : "external";
        const xid = `ext:${cat}:${label}`;
        const xn = this.addNode({ id: xid, kind, category: cat, name: label, package: pkg, filePath: def.file, line, resolution: "resolved", depth: depth + 1, detail: describeExternal(cat, pkg, n) });
        if (xn) this.addEdge(nodeId, xid, cat === "database" || cat === "cache" ? "queries" : "external", { line, conditional: isConditional, file: def.file, via: callVia(mod, cp, callee, null) });
        continue;
      }
      // Model / DB-client calls: User.findById(), prisma.user.findMany(), db.query()
      if (callee.type === "MemberExpression") {
        const method = propName(callee);
        const root = memberRoot(callee);
        const rootTarget = root?.type === "Identifier" ? resolveExpr(this.project, mod, findRootPath(cp.get("callee")), { className: def.className }) : null;
        const looksModel = rootTarget?.type === "value" && (rootTarget.model || /^[A-Z]/.test(root.name));
        const looksClient = root?.type === "Identifier" && DB_ROOTS.has(root.name);
        if ((looksModel && rootTarget.model) || (DB_METHODS.has(method) && (looksModel || looksClient))) {
          const label = exprLabel(callee);
          const xid = `db:${label}`;
          const xn = this.addNode({ id: xid, kind: "database", category: "database", name: label, filePath: rootTarget?.file || def.file, line: rootTarget?.file && rootTarget.file !== def.file ? 0 : line, model: looksModel ? root.name : null, resolution: "pattern", depth: depth + 1, detail: looksModel ? `Data-model operation on ${root.name}` : `Query through ${root.name}` });
          if (xn) this.addEdge(nodeId, xid, "queries", { line, conditional: isConditional, file: def.file, via: callVia(mod, cp, callee, null) });
          continue;
        }
      }
      if (target?.type === "factory" || !target) {
        const label = exprLabel(callee);
        const root = callee.type === "Identifier" ? callee : memberRoot(callee);
        const binding = root?.type === "Identifier" ? cp.scope.getBinding(root.name) : null;
        if (root?.type === "ThisExpression" && callee.type === "MemberExpression" && unwrapTS(callee.object).type === "ThisExpression") {
          if (!unresolved.some((u) => u.label === label)) unresolved.push({ label, line, reason: "method not found on class" });
          continue;
        }
        // Calls on local data (arrays, strings, req.body, params) or unbound globals are not part of the flow.
        if (!binding) continue;
        if (binding.kind === "param") {
          if (callee.type === "Identifier") unresolved.push({ label, line, reason: "callback passed as a parameter" });
          continue;
        }
        if (binding.scope.block.type !== "Program" && callee.type === "MemberExpression") continue;
        if (!unresolved.some((u) => u.label === label)) unresolved.push({ label, line, reason: target?.type === "factory" ? "returned by a factory call" : "dynamic or not resolvable statically" });
      }
    }
    for (const tp of throws) {
      const arg = unwrapTS(tp.node.argument);
      const label = exprLabel(arg);
      let status = null;
      const a0 = arg?.type === "NewExpression" ? arg.arguments[0] : null;
      if (a0?.type === "NumericLiteral") status = a0.value;
      else if (a0?.type === "MemberExpression" && NAMED_STATUS[propName(a0)]) status = NAMED_STATUS[propName(a0)];
      const tid = `throw:${nodeId}:${label}:${status ?? ""}`;
      const tn = this.addNode({ id: tid, kind: "error", name: `throw ${label}`, status: status ?? undefined, filePath: def.file, line: lineOf(tp.node), resolution: "resolved", depth: depth + 1, detail: status ? `Throws an error carrying HTTP ${status}; an error handler turns it into the response.` : "Throws an error; it propagates to the caller / error handler." });
      if (tn) this.addEdge(nodeId, tid, "error", { line: lineOf(tp.node), conditional: isConditionalCall(tp, fnPath), file: def.file, via: { kind: "throw" } });
    }
    if (unresolved.length) {
      node.unresolved = unresolved.slice(0, 25);
      this.unresolvedTotal += unresolved.length;
    }
    if (libraryCalls.size) node.libraryCalls = [...libraryCalls].slice(0, 20);
  }

  resParamName(def, ctxRes) {
    if (ctxRes && def.params[ctxRes.index]) return def.params[ctxRes.index];
    if (def.isRouteFn) return def.params[1] || null;
    const p = def.params.find((x) => /^(res|response|reply)$/.test(x));
    return p || null;
  }

  tracePy(def, nodeId, depth) {
    const mod = pyModule(this.project, def.file);
    if (!mod) return;
    const node = this.nodes.get(nodeId);
    const body = mod.lines.slice(def.line, def.endLine);
    const unresolved = [];
    const libraryCalls = new Set();
    const seen = new Set();
    for (let i = 0; i < body.length; i++) {
      const raw = body[i];
      const line = def.line + 1 + i;
      const code = raw.replace(/#.*$/, "");
      if (!code.trim()) continue;
      const conditional = /^\s*(if|elif|else|except|try)\b/.test(code) || pyIndent(raw) > pyIndent(mod.lines[def.line] || "") ;
      // Responses. In the route handler any returned value is the response;
      // in helpers only explicit Flask/FastAPI response constructors count.
      const ret = code.match(/^\s*return\s+(.+)$/);
      if (ret) {
        const expr = ret[1].trim();
        const isHandler = node.kind === "handler";
        const ctor = expr.match(/^(jsonify|render_template|redirect|make_response|send_file|JSONResponse|Response|HTMLResponse|RedirectResponse|PlainTextResponse|FileResponse)\s*\(/);
        const literal = /^[{["'fb]/.test(expr) && !/^\w+\s*\(/.test(expr.replace(/^f(?=["'])/, ""));
        const tuple = expr.match(/,\s*([\w.]+)\s*\)?\s*$/);
        const callsProjectFn = (() => {
          const m = expr.match(/^([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/);
          if (!m) return false;
          const [, a, b] = m;
          if (!b) {
            if (mod.defs.has(a)) return true;
            const imp = mod.imports.get(a);
            return !!(imp?.file && pyModule(this.project, imp.file)?.defs.has(imp.imported));
          }
          const imp = mod.imports.get(a);
          return !!(imp?.file && pyModule(this.project, imp.file)?.defs.has(b));
        })();
        if (ctor || (isHandler && !callsProjectFn && expr !== "None")) {
          const sm = expr.match(/,\s*(\d{3})\s*(?:,|\)?\s*$)/) || expr.match(/status_code\s*=\s*(\d{3})/);
          const code2 = sm ? Number(sm[1]) : tuple && !literal && !/^\d{3}$/.test(tuple[1]) && !ctor && !/\(/.test(expr) ? "dynamic" : ctor?.[1] === "redirect" || ctor?.[1] === "RedirectResponse" ? 302 : 200;
          const sender = ctor ? (ctor[1] === "render_template" ? "render" : ctor[1]) : "return";
          const rid = `res:${nodeId}:${code2}:${sender}`;
          if (this.addNode({ id: rid, kind: "response", name: `${code2} ${sender}`, status: code2, statusImplicit: !sm && code2 !== "dynamic", sender, filePath: def.file, line, resolution: "pattern", depth: depth + 1 })) this.addEdge(nodeId, rid, "responds", { line, conditional });
        }
      }
      const ab = code.match(/\babort\(\s*(\d{3})/) || code.match(/raise\s+HTTPException\(\s*(?:status_code\s*=\s*)?(\d{3})/);
      if (ab) {
        const rid = `res:${nodeId}:${ab[1]}:abort`;
        if (this.addNode({ id: rid, kind: "response", name: `${ab[1]} abort`, status: Number(ab[1]), sender: "abort", filePath: def.file, line, resolution: "pattern", depth: depth + 1 })) this.addEdge(nodeId, rid, "responds", { line, conditional: true });
      }
      // DB patterns
      const db = code.match(/\b((?:db\.session|session|cursor|conn|connection|db)\.(?:query|execute|add|commit|delete|get|get_or_404|first_or_404|one_or_404|paginate|scalars|scalar|merge|flush|fetchone|fetchall|refresh|rollback)|[A-Z]\w*\.(?:objects\.\w+|query\.\w+|query))\s*\(/);
      if (db) {
        const xid = `db:${db[1]}`;
        if (this.addNode({ id: xid, kind: "database", category: "database", name: db[1], filePath: def.file, line, resolution: "pattern", depth: depth + 1, detail: "Database access (pattern match)" })) this.addEdge(nodeId, xid, "queries", { line, conditional });
      }
      for (const m of code.matchAll(/(?<![.\w])((?:self\.)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/g)) {
        let name = m[1];
        if (/^(if|for|while|return|print|len|str|int|float|dict|list|set|tuple|isinstance|range|super|jsonify|abort|render_template|redirect|enumerate|zip|sorted|min|max|sum|any|all|open|bool|type|getattr|hasattr|setattr|Exception|ValueError|HTTPException|JSONResponse|Response)$/.test(name)) continue;
        let target = null;
        if (name.startsWith("self.") && def.className) target = mod.defs.get(`${def.className}.${name.slice(5)}`);
        else if (!name.includes(".")) {
          target = mod.defs.get(name);
          if (!target && mod.imports.has(name)) {
            const imp = mod.imports.get(name);
            if (imp.file) target = pyModule(this.project, imp.file)?.defs.get(imp.imported);
            else { libraryCalls.add(`${name} (${imp.pkg})`); continue; }
          }
        } else {
          const [obj, prop] = name.split(".");
          const imp = mod.imports.get(obj);
          if (imp?.file) {
            const tm = pyModule(this.project, imp.file);
            // `module.fn()` or `ImportedClass.method()`
            target = tm?.defs.get(prop) || (tm ? pyMethod(tm, imp.imported, prop) : null);
          }
          else if (mod.defs.has(`${obj}.${prop}`)) target = mod.defs.get(`${obj}.${prop}`);
          else if (imp?.pkg && /^(requests|httpx|aiohttp|urllib)/.test(imp.pkg)) {
            const xid = `ext:http:${name}`;
            if (this.addNode({ id: xid, kind: "external", category: "http", name, package: imp.pkg, filePath: def.file, line, resolution: "resolved", depth: depth + 1, detail: "Outbound HTTP request" })) this.addEdge(nodeId, xid, "external", { line, conditional });
            continue;
          } else continue;
        }
        if (!target) {
          if (seen.has(name) || name.includes(".")) continue;
          seen.add(name);
          const imp = mod.imports.get(name);
          const clsFile = mod.classes.has(name) ? def.file : imp?.file && pyModule(this.project, imp.file)?.classes.has(imp.imported) ? imp.file : null;
          if (clsFile) libraryCalls.add(`${name}() — class in ${clsFile}`);
          else unresolved.push({ label: name, line, reason: "not resolvable statically" });
          continue;
        }
        if (target.key === def.key) continue;
        if (!target.key) continue;
        const child = this.fnNode(target);
        if (!child) continue;
        const pyImp = mod.imports.get(name.split(".")[0]);
        this.addEdge(nodeId, child.id, "calls", { line, conditional, file: def.file, via: name.startsWith("self.") ? { kind: "this-method", local: name } : pyImp ? { kind: "import", local: name.split(".")[0], spec: pyImp.spec, imported: pyImp.imported, importLine: pyImp.line, importFile: def.file, defFile: target.file } : { kind: "same-file", local: name } });
        this.traceDef(target, child.id, depth + 1);
      }
    }
    if (unresolved.length) {
      node.unresolved = unresolved.slice(0, 25);
      this.unresolvedTotal += unresolved.length;
    }
    if (libraryCalls.size) node.libraryCalls = [...libraryCalls].slice(0, 20);
  }
}

/**
 * Where a module-level value comes from when it is built by calling a
 * package / function, e.g. `const authLimiter = rateLimit({...})`.
 */
function valueOrigin(project, target) {
  const mod = project.module(target.file);
  const init = mod?.values.get(target.name);
  const call = unwrapTS(init);
  if (!call || call.type !== "CallExpression") return null;
  const root = call.callee.type === "Identifier" ? call.callee : memberRoot(call.callee);
  let pkg = null;
  if (root?.type === "Identifier") {
    const imp = mod.imports.get(root.name);
    if (imp && !imp.file) pkg = imp.pkg;
  }
  return { file: target.file, line: lineOf(call), endLine: endLineOf(call), factory: exprLabel(call.callee), pkg };
}

/** Leading JSDoc / line comments (JS) or the docstring (Python) of a definition. */
function docFor(project, def) {
  try {
    if (def.lang === "py") {
      const lines = pyModule(project, def.file)?.lines || [];
      for (let i = def.line; i < Math.min(def.line + 3, lines.length); i++) {
        const t = lines[i].trim();
        if (!t) continue;
        const m = t.match(/^[rbu]?("""|\'\'\')([\s\S]*)/);
        if (!m) return null;
        let text = m[2];
        let j = i;
        while (!text.includes(m[1]) && j + 1 < lines.length && j - i < 20) text += "\n" + lines[++j].trim();
        return cleanDoc(text.split(m[1])[0]);
      }
      return null;
    }
    let p = def.path;
    for (let i = 0; p && i < 5; i++, p = p.parentPath) {
      const c = p.node.leadingComments;
      if (c && c.length) {
        const last = c[c.length - 1];
        if (lineOf(p.node) - (last.loc?.end?.line || 0) > 1) return null;
        return cleanDoc(last.value);
      }
      if (p.isStatement() && !p.parentPath?.isExportDeclaration()) break;
    }
  } catch {
    return null;
  }
  return null;
}

function cleanDoc(raw) {
  const text = raw
    .split("\n")
    .map((l) => l.replace(/^\s*\*+\s?/, "").trim())
    .filter((l) => l && !/^@(param|returns?|type|throws|example|swagger)\b/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^(eslint|istanbul|prettier|@ts-|global )/.test(text)) return null;
  return text.length > 400 ? text.slice(0, 397) + "…" : text;
}

function sourceLine(project, file, line) {
  if (!file || !line) return null;
  if (!project.lineCache) project.lineCache = new Map();
  let lines = project.lineCache.get(file);
  if (!lines) {
    const text = project.read(file);
    if (text == null) return null;
    lines = text.split("\n");
    project.lineCache.set(file, lines);
  }
  const l = lines[line - 1];
  if (l == null) return null;
  const t = l.trim();
  return t.length > 220 ? t.slice(0, 217) + "…" : t;
}

/**
 * Plain-language analysis notes: what the static analysis could not prove,
 * why, and what the developer can do about it.
 */
function buildNotes(fb, endpoint, nodes) {
  const notes = [];
  const add = (n) => notes.push(n);
  if (endpoint.framework === "express" && !endpoint.mountResolved) {
    add({ id: "mount-missing", severity: "warn", title: "Full URL may be incomplete",
      detail: `The router in ${endpoint.filePath} that defines this route was not found being mounted with app.use(). The path shown (${endpoint.path}) is the path inside that router; the real URL probably has a prefix in front of it.`,
      hint: "Look for where this router file is imported and passed to app.use(); dynamic mounting (computed paths, plugin loaders) can't be followed statically." });
  }
  const unresolvedHandler = nodes.find((n) => n.kind === "handler" && n.resolution === "unresolved");
  if (unresolvedHandler) {
    add({ id: "handler-unresolved", severity: "warn", title: "Handler body not found",
      detail: `The route passes "${unresolvedHandler.name}" as its handler, but the analyzer could not find the function definition behind it. ${unresolvedHandler.detail || ""} Everything after the handler is therefore unknown, not absent.`,
      hint: "Common causes: the handler comes from a factory, a dependency-injection container or a package.", nodeIds: [unresolvedHandler.id] });
  }
  const withUnresolved = nodes.filter((n) => n.unresolved?.length);
  if (withUnresolved.length) {
    const total = withUnresolved.reduce((s, n) => s + n.unresolved.length, 0);
    add({ id: "unresolved-calls", severity: "warn", title: `${total} call${total === 1 ? "" : "s"} could not be followed`,
      detail: `${withUnresolved.map((n) => `${n.name} → ${n.unresolved.slice(0, 3).map((u) => u.label + "()").join(", ")}${n.unresolved.length > 3 ? "…" : ""}`).join("; ")}. These calls exist in the code but their target can't be determined without running it (functions passed as arguments, values chosen at runtime, methods on objects of unknown type). They are not drawn, so the real flow may include more steps.`,
      hint: "Select a node with a ?N badge to see each unresolved call, its line, and the reason.", nodeIds: withUnresolved.map((n) => n.id) });
  }
  const unresolvedMw = nodes.filter((n) => n.kind === "middleware" && n.resolution === "unresolved");
  if (unresolvedMw.length) {
    add({ id: "middleware-unresolved", severity: "info", title: `${unresolvedMw.length} middleware could not be resolved`,
      detail: `${unresolvedMw.map((n) => n.name).join(", ")} ${unresolvedMw.length === 1 ? "is" : "are"} registered for this route, but the function behind ${unresolvedMw.length === 1 ? "it" : "them"} was not found. They still run (their registration is in the code); what they do inside is unknown.`,
      nodeIds: unresolvedMw.map((n) => n.id) });
  }
  const pkgMw = nodes.filter((n) => n.kind === "middleware" && n.package);
  if (pkgMw.length) {
    add({ id: "package-middleware", severity: "info", title: "Third-party middleware is a black box",
      detail: `${pkgMw.map((n) => n.name).join(", ")} come${pkgMw.length === 1 ? "s" : ""} from npm packages. The analyzer shows where they are registered but does not trace code inside node_modules.` , nodeIds: pkgMw.map((n) => n.id) });
  }
  const depthCut = nodes.filter((n) => n.truncated);
  if (depthCut.length) {
    add({ id: "depth-limit", severity: "warn", title: "Depth limit reached",
      detail: `Tracing stopped at ${depthCut.map((n) => n.name).slice(0, 4).join(", ")}${depthCut.length > 4 ? "…" : ""} because the call chain is deeper than ${fb.maxDepth} levels. Calls below ${depthCut.length === 1 ? "this node" : "these nodes"} are not shown.`,
      hint: "Increase Depth in the toolbar to follow further.", nodeIds: depthCut.map((n) => n.id) });
  }
  if (fb.nodeLimitHit) {
    add({ id: "node-limit", severity: "warn", title: "Graph size limit reached",
      detail: `This flow reaches more than ${fb.maxNodes} distinct steps; the rest were left out to keep the view responsive.`,
      hint: "Lower the Depth to focus on the first layers of the flow." });
  }
  if (!nodes.some((n) => n.kind === "response")) {
    add({ id: "no-response", severity: "warn", title: "No response statement found",
      detail: "None of the traced functions call res.json / res.send / res.status… (or return a response, in Python). The response is probably sent by code that couldn't be followed: an unresolved call, a package (e.g. a static file server), or an error handler.",
      hint: "Check the unresolved calls and the handler's source." });
  }
  const dyn = nodes.filter((n) => n.kind === "response" && n.status === "dynamic");
  if (dyn.length) {
    add({ id: "dynamic-status", severity: "info", title: "Status code decided at runtime",
      detail: `${dyn.length === 1 ? "One response uses" : `${dyn.length} responses use`} a status computed from a variable, so the exact code isn't known statically.`, nodeIds: dyn.map((n) => n.id) });
  }
  const pattern = nodes.filter((n) => n.resolution === "pattern");
  if (pattern.length) {
    add({ id: "pattern-match", severity: "info", title: "Some steps were recognised by pattern",
      detail: `${pattern.length} step${pattern.length === 1 ? " was" : "s were"} identified from a well-known API shape (e.g. User.findOne(), db.session.commit(), return jsonify(...)) rather than by resolving a definition in this repository. ${endpoint.framework !== "express" ? "Python analysis is line-based and less precise than the JavaScript/TypeScript AST analysis." : ""}`.trim(),
      nodeIds: pattern.map((n) => n.id) });
  }
  return notes;
}

/**
 * Describe how a call's callee was bound, for "why is this connected?":
 * an import (with its specifier and line), a same-file definition, a class
 * method via `this`, an instance field, or a local variable.
 */
function callVia(mod, cp, callee, def) {
  const root = callee.type === "Identifier" ? callee : memberRoot(callee);
  const expr = exprLabel(callee);
  if (root?.type === "ThisExpression") {
    const obj = callee.type === "MemberExpression" ? unwrapTS(callee.object) : null;
    if (obj?.type === "MemberExpression") return { kind: "instance-field", expr, field: propName(obj) };
    return { kind: "this-method", expr };
  }
  if (root?.type !== "Identifier") return { kind: "expression", expr };
  const binding = cp.scope.getBinding(root.name);
  if (binding && binding.scope.block.type !== "Program") {
    return { kind: "local", expr, local: root.name, line: lineOf(binding.path.node) };
  }
  const imp = mod.imports.get(root.name);
  if (imp) {
    return { kind: imp.file ? "import" : "package", expr, local: root.name, spec: imp.spec, imported: imp.imported, importLine: imp.line, importFile: mod.rel, resolvedFile: imp.file || null, defFile: def?.file || null };
  }
  if (mod.instances.has(root.name)) return { kind: "instance", expr, local: root.name, className: mod.instances.get(root.name) };
  return { kind: "same-file", expr, local: root.name, defFile: def?.file || null };
}

function isResponseBinding(cp, name, resName) {
  if (resName && name === resName) return true;
  const b = cp.scope.getBinding(name);
  return !!b && b.kind === "param" && /^(res|response|reply)$/.test(name);
}

function isConditionalCall(cp, fnPath) {
  let p = cp.parentPath;
  while (p && p !== fnPath) {
    if (p.isIfStatement() || p.isConditionalExpression() || p.isSwitchCase() || p.isCatchClause() || p.isLogicalExpression()) return true;
    p = p.parentPath;
  }
  return false;
}

function memberRoot(n) {
  let cur = n;
  while (cur && (cur.type === "MemberExpression" || cur.type === "OptionalMemberExpression" || cur.type === "CallExpression" || cur.type === "TSNonNullExpression")) {
    cur = cur.type === "CallExpression" ? cur.callee : cur.expression || cur.object;
  }
  return cur;
}
function findRootPath(p) {
  let cur = p;
  while (cur && (cur.isMemberExpression() || cur.isOptionalMemberExpression())) cur = cur.get("object");
  return cur;
}

// Status-code constants from http-status / http-status-codes (StatusCodes.*)
const NAMED_STATUS = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, MOVED_PERMANENTLY: 301, FOUND: 302, NOT_MODIFIED: 304,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409, GONE: 410, UNPROCESSABLE_ENTITY: 422, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503,
};

function responseStatus(callee, call) {
  const sender = propName(callee);
  if (sender === "sendStatus" && call.arguments[0]?.type === "NumericLiteral") return { code: call.arguments[0].value, implicit: false };
  if (sender === "redirect") {
    const a0 = call.arguments[0];
    return { code: a0?.type === "NumericLiteral" ? a0.value : 302, implicit: a0?.type !== "NumericLiteral" };
  }
  let cur = callee.object;
  while (cur && cur.type === "CallExpression" && cur.callee.type === "MemberExpression") {
    if (propName(cur.callee) === "status") {
      const a = cur.arguments[0];
      if (a?.type === "NumericLiteral") return { code: a.value, implicit: false };
      const named = a && (a.type === "MemberExpression" ? propName(a) : null);
      if (named && NAMED_STATUS[named]) return { code: NAMED_STATUS[named], implicit: false, named: exprLabel(a) };
      return { code: "dynamic", implicit: false, named: a ? exprLabel(a) : null };
    }
    cur = cur.callee.object;
  }
  return { code: 200, implicit: true };
}

function describeExternal(cat, pkg, call) {
  const a0 = strValue(call.arguments?.[0]);
  switch (cat) {
    case "http": return a0 ? `Outbound HTTP request to ${a0}` : "Outbound HTTP request";
    case "database": return `Database call via ${pkg}`;
    case "cache": return `Cache access via ${pkg}`;
    case "auth": return `Authentication / crypto via ${pkg}`;
    case "queue": return `Message queue via ${pkg}`;
    case "filesystem": return "Filesystem access";
    default: return `Third-party service via ${pkg}`;
  }
}

/**
 * Trace one endpoint. Returns a graph of nodes + edges with call-site lines.
 */
export function traceEndpoint(project, endpoint, opts = {}) {
  const fb = new FlowBuilder(project, opts);
  const entryId = `endpoint:${endpoint.id}`;
  fb.addNode({
    id: entryId, kind: "endpoint", name: `${endpoint.method} ${endpoint.path}`, method: endpoint.method, path: endpoint.path,
    filePath: endpoint.filePath, line: endpoint.startLine, endLine: endpoint.endLine, framework: endpoint.framework, resolution: "resolved", depth: 0,
    mountChain: endpoint.mountChain, mountResolved: endpoint.mountResolved,
  });
  const warnings = [];
  if (!endpoint.mountResolved && endpoint.framework === "express") warnings.push("The router that defines this route was not found mounted with app.use(); the full URL prefix may differ.");

  let prev = entryId;
  const internal = endpoint._internal || {};
  if (internal.pyDef) {
    const def = internal.pyDef;
    let step = 1;
    for (const dec of internal.pyDecorators || []) {
      const r = resolvePyDecorator(project, internal.pyFile, dec.name);
      let id;
      if (r?.def) {
        const n = fb.fnNode(r.def, "middleware");
        if (!n) break;
        n.kind = "middleware";
        n.depth = step;
        id = n.id;
        fb.addEdge(prev, id, "next", { line: dec.line, file: endpoint.filePath, via: { kind: "middleware", scope: { level: "decorator", router: null, prefix: null } } });
        fb.traceDef(r.def, id, 1);
      } else {
        id = `mw:${dec.label}:${endpoint.filePath}:${dec.line}`;
        const n = fb.addNode({ id, kind: "middleware", name: dec.label, filePath: r?.file || endpoint.filePath, line: r?.line || dec.line, resolution: r ? "resolved" : "unresolved", package: r?.pkg || null, factoryName: r?.factory || null, depth: step,
          detail: r?.pkg ? (r.factory ? `Decorator provided by ${r.factory} (package '${r.pkg}'), created in ${r.file}:${r.line}.` : `Decorator from the package '${r.pkg}'.`) : "Decorator whose definition could not be found." });
        if (!n) break;
        fb.addEdge(prev, id, "next", { line: dec.line, file: endpoint.filePath, via: { kind: "middleware", scope: { level: "decorator", router: null, prefix: null } } });
      }
      prev = id;
      step++;
    }
    const h = fb.fnNode(def, "handler");
    h.depth = step;
    fb.addEdge(prev, h.id, "handles", { line: endpoint.startLine, file: endpoint.filePath, via: { kind: "decorator" } });
    fb.traceDef(def, h.id, 1);
  } else if (internal.handlerArg) {
    const mod = project.module(internal.scanRel);
    let step = 1;
    for (const mw of internal.middleware || []) {
      const mwMod = project.module(mw.scanRel) || mod;
      const target = resolveExpr(project, mwMod, mw.argPath);
      let id;
      if (target?.type === "fn") {
        const n = fb.fnNode({ ...target.def, wrapper: target.wrapper }, "middleware");
        if (!n) break;
        n.kind = "middleware";
        n.depth = step;
        id = n.id;
        fb.addEdge(prev, id, "next", { line: mw.line, file: mw.file, via: { kind: "middleware", scope: mw.scope || null } });
        fb.traceDef(target.def, id, 1);
      } else {
        const pkgTarget = target?.type === "factory" ? target.callee : target;
        id = `mw:${mw.label}:${mw.file}:${mw.line}`;
        const origin = target?.type === "value" ? valueOrigin(project, target) : null;
        if (origin) {
          const n = fb.addNode({ id, kind: "middleware", name: mw.label, filePath: origin.file, line: origin.line, endLine: origin.endLine, resolution: "resolved", package: origin.pkg, factoryName: origin.factory, depth: step,
            detail: `Created in ${origin.file}:${origin.line} by calling ${origin.factory}()${origin.pkg ? ` from the package '${origin.pkg}'` : ""}.` });
          if (!n) break;
          fb.addEdge(prev, id, "next", { line: mw.line, file: mw.file, via: { kind: "middleware", scope: mw.scope || null } });
          prev = id;
          step++;
          continue;
        }
        const n = fb.addNode({ id, kind: "middleware", name: mw.label, filePath: mw.file, line: mw.line, resolution: pkgTarget?.type === "package" || pkgTarget?.type === "fn" ? "resolved" : "unresolved", package: pkgTarget?.type === "package" ? pkgTarget.pkg : null, depth: step, detail: pkgTarget?.type === "package" ? `Middleware from package ${pkgTarget.pkg}` : target?.type === "factory" && target.callee?.type === "fn" ? `Created by ${target.callee.def.name}()` : "Middleware could not be resolved statically" });
        if (!n) break;
        if (target?.type === "factory" && target.callee?.type === "fn") {
          n.filePath = target.callee.def.file;
          n.line = target.callee.def.line;
          n.endLine = target.callee.def.endLine;
          n.factoryName = target.callee.def.name;
          // Trace the factory body: the returned middleware lives inside it.
          fb.traceDef({ ...target.callee.def }, id, 1);
        }
        fb.addEdge(prev, id, "next", { line: mw.line, file: mw.file, via: { kind: "middleware", scope: mw.scope || null } });
      }
      prev = id;
      step++;
    }
    const target = resolveExpr(project, mod, internal.handlerArg);
    if (target?.type === "fn") {
      const def = { ...target.def, isRouteFn: true, wrapper: target.wrapper };
      const h = fb.fnNode(def, "handler");
      if (h) {
        h.kind = "handler";
        h.depth = step;
        fb.addEdge(prev, h.id, "handles", { line: endpoint.startLine, file: endpoint.filePath, via: { kind: "route", handlerLabel: endpoint.handler, wrapper: target.wrapper || null, defFile: target.def.file } });
        fb.traceDef(def, h.id, 1);
      }
    } else {
      const id = `handler:${endpoint.id}`;
      fb.addNode({ id, kind: "handler", name: endpoint.handler || "handler", filePath: endpoint.filePath, line: endpoint.startLine, resolution: "unresolved", depth: step, detail: target?.type === "factory" ? `Handler is produced by ${target.label}; its body cannot be followed statically.` : "The handler reference could not be resolved to a function definition." });
      fb.addEdge(prev, id, "handles", { line: endpoint.startLine, file: endpoint.filePath, via: { kind: "route", handlerLabel: endpoint.handler } });
      warnings.push("The route handler could not be resolved to a definition, so downstream calls are unknown.");
    }
  }

  const nodes = [...fb.nodes.values()];
  const edges = [...fb.edges.values()];
  // Evidence: the source text at each node's definition and each connection's line.
  for (const n of nodes) {
    if (n.line && n.filePath && !n.signature) n.signature = sourceLine(project, n.filePath, n.line);
  }
  for (const e of edges) {
    if (e.lines.length && e.file) e.snippet = sourceLine(project, e.file, e.lines[0]);
    if (e.via?.importLine && e.via.importFile) e.via.importText = sourceLine(project, e.via.importFile, e.via.importLine);
  }
  const notes = buildNotes(fb, endpoint, nodes);
  if (fb.truncated) warnings.push(`The flow was truncated (limit ${fb.maxNodes} nodes / depth ${fb.maxDepth}).`);
  if (fb.unresolvedTotal) warnings.push(`${fb.unresolvedTotal} call${fb.unresolvedTotal === 1 ? "" : "s"} could not be resolved statically (callbacks, parameters or dynamic dispatch). They are listed on the node that makes them.`);
  if (!nodes.some((n) => n.kind === "response")) warnings.push("No response statement (res.json/send/…) was found on the traced path; the response may be sent by code that could not be followed.");

  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  return {
    endpoint: publicEndpoint(endpoint),
    entryId,
    nodes,
    edges,
    stats: { nodes: nodes.length, edges: edges.length, counts, maxDepth: Math.max(0, ...nodes.map((n) => n.depth || 0)), unresolved: fb.unresolvedTotal },
    truncated: fb.truncated,
    partial: fb.truncated || fb.unresolvedTotal > 0 || warnings.length > 0,
    warnings,
    notes,
    analysis: { kind: "static", description: "Derived from the source code without running it. Shows every path the code makes possible; at runtime a request follows only the branches its data selects." },
  };
}

/**
 * Backwards-compatible helper: trace the first endpoint of `endpoints`
 * against `fileDir`. Returns the graph plus legacy `entry` / `paths` fields.
 */
export function traceFlow(endpoints, fileDir, maxDepth = 8) {
  const ep = endpoints?.[0];
  if (!ep) return { entry: null, paths: [], nodes: [], edges: [], partial: true, note: "No endpoint provided", warnings: [] };
  const project = new Project(fileDir);
  const all = discoverEndpointsInProject(project);
  const full = all.find((e) => e.id === ep.id) || all.find((e) => e.method === ep.method && e.path === ep.path) || all.find((e) => e.method === ep.method && e.filePath === ep.filePath && e.startLine === ep.startLine);
  if (!full) return { entry: null, paths: [], nodes: [], edges: [], partial: true, note: "Endpoint not found in source", warnings: [] };
  const result = traceEndpoint(project, full, { maxDepth });
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const out = new Map();
  for (const e of result.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }
  const paths = [];
  const walk = (id, acc, seen) => {
    if (paths.length > 50) return;
    const next = (out.get(id) || []).filter((t) => !seen.has(t));
    if (!next.length) { paths.push({ steps: acc.map((x) => byId.get(x)), depth: acc.length - 1, complete: true }); return; }
    for (const t of next) walk(t, [...acc, t], new Set([...seen, t]));
  };
  walk(result.entryId, [result.entryId], new Set([result.entryId]));
  return { ...result, entry: byId.get(result.entryId), paths, note: result.partial ? "Partial resolution (static analysis limits)" : "Complete trace" };
}

/**
 * Call sites in `fromRel` whose callee resolves (through imports, re-exports,
 * instances and classes) to a function defined in `toRel`. AST-based, so a
 * same-named method on an unrelated object is never reported.
 */
export function callSitesInto(project, fromRel, toRel, limit = 30) {
  const mod = project.module(fromRel);
  if (!mod) return [];
  const out = [];
  const lines = project.read(fromRel)?.split("\n") || [];
  traverse(mod.ast, {
    CallExpression(cp) {
      if (out.length >= limit) return cp.stop();
      const cls = cp.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
      const className = cls?.node.id?.name || null;
      let target = null;
      try {
        target = resolveExpr(project, mod, cp.get("callee"), { className });
      } catch {
        target = null;
      }
      if (target?.type === "fn" && target.def.file === toRel) {
        const line = lineOf(cp.node);
        if (!out.some((o) => o.line === line && o.name === target.def.name)) {
          out.push({ line, name: target.def.name, defLine: target.def.line, text: (lines[line - 1] || "").trim().slice(0, 140) });
        }
      }
    },
  });
  return out;
}
