/**
 * Endpoint Discovery and API Flow Tracing
 * Static analysis for Express (JS/TS) and basic Python Flask routes.
 */
import fs from "fs";
import path from "path";

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".cache",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL", "USE"]);

// ------------------------------------------------------------------
// Static endpoint discovery
// ------------------------------------------------------------------

export function discoverEndpoints(sourceDir) {
  const results = [];

  function visit(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const item of items) {
      if (IGNORE.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        visit(full);
      } else if (item.isFile() && /\.(js|ts|jsx|tsx|py)$/.test(item.name)) {
        const rel = path.relative(sourceDir, full).replace(/\\/g, "/");
        const endpoints = extractFromFile(full, rel, sourceDir);
        results.push(...endpoints);
      }
    }
  }

  visit(sourceDir);
  return deduplicateEndpoints(results);
}

function deduplicateEndpoints(endpoints) {
  const map = new Map();
  for (const ep of endpoints) {
    const key = `${ep.method}:${ep.path}`;
    if (!map.has(key)) {
      map.set(key, ep);
    } else {
      const existing = map.get(key);
      // Prefer the one with handler info over missing
      if (!existing.handler && ep.handler) {
        map.set(key, ep);
      } else if (existing.confidence !== "high" && ep.confidence === "high") {
        map.set(key, ep);
      }
    }
  }
  return Array.from(map.values());
}

function extractFromFile(filePath, relativePath, sourceDir) {
  const endpoints = [];
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return endpoints;
  }

  const framework = relativePath.endsWith(".py") ? "flask_fastapi" : "express";

  if (framework === "express") {
    // Pattern 1: router.get('/path', handler) or app.get('/path', handler)
    const routeRegex = /(?:app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*([^)]+))?\)/gi;
    let m;
    while ((m = routeRegex.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      if (method === "USE") continue;
      const rawPath = m[2];
      if (!isRoutePath(rawPath)) continue; // e.g. app.get('trust proxy') reads a setting
      const handlerRaw = m[3] ? m[3].trim() : null;
      const pathStr = normalizeRoutePath(rawPath);
      const handlerName = resolveHandlerName(handlerRaw, content, filePath);
      endpoints.push({
        framework: "express",
        method: method === "ALL" ? "ALL" : method,
        path: pathStr,
        handler: handlerName,
        filePath: relativePath,
        startLine: findLineNumber(content, m.index),
        endLine: findLineNumber(content, m.index) + 1,
        confidence: handlerName ? "high" : "medium",
      });
    }

    // Pattern 2: router.route("/").post(handler).get(handler)
    const chainRegex = /router\.(route)\s*\(\s*['"]([^'"]+)['"](?:\s*\)\s*\.([a-z]+)\s*\(([^)]+)\)\s*)+/gi;
    // Actually match each chain method individually: .post(...).get(...)
    const chainMethodRegex = /\.([a-z]+)\s*\(\s*([^)]+)\)/gi;
    // Find route definitions first
    const routeDefRegex = /router\.route\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let routeDefMatch;
    while ((routeDefMatch = routeDefRegex.exec(content)) !== null) {
      const routePath = normalizeRoutePath(routeDefMatch[1]);
      // After this match, scan the following text for chained methods
      const afterIndex = routeDefRegex.lastIndex;
      const afterText = content.substring(afterIndex, Math.min(afterIndex + 300, content.length));
      const chainedMethods = [...afterText.matchAll(/\.(get|post|put|patch|delete|all)\s*\(([^)]+)\)/gi)];
      for (const cm of chainedMethods) {
        const method = cm[1].toUpperCase();
        if (!HTTP_METHODS.has(method)) continue;
        const handlerRaw = cm[2] ? cm[2].trim() : null;
        const handlerName = resolveHandlerName(handlerRaw, content, filePath);
        endpoints.push({
          framework: "express",
          method: method === "ALL" ? "ALL" : method,
          path: routePath,
          handler: handlerName,
          filePath: relativePath,
          startLine: findLineNumber(content, routeDefMatch.index),
          endLine: findLineNumber(content, routeDefMatch.index) + 5,
          confidence: handlerName ? "high" : "medium",
        });
      }
    }

    // Pattern 3: app.use("/prefix", routerVariable) — resolve prefix
    const mountRegex = /app\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z_][a-zA-Z0-9_]*)\)/gi;
    let mountMatch;
    const mountPrefixes = new Map(); // variable -> prefix
    while ((mountMatch = mountRegex.exec(content)) !== null) {
      const prefix = normalizeRoutePath(mountMatch[1]);
      const routerVar = mountMatch[2];
      mountPrefixes.set(routerVar, prefix);
    }

    // If we found mounts but no routes in this file, try to resolve the router file
    for (const [routerVar, prefix] of mountPrefixes) {
      // Try to find the imported router file
      const importRegex = /from\s+['"](.+?)['"]/g;
      const imports = [...content.matchAll(importRegex)];
      for (const imp of imports) {
        const importPath = imp[1];
        const baseDir = path.dirname(filePath);
        const resolved = resolveImportToFile(importPath, baseDir, sourceDir);
        if (resolved) {
          const routerContent = fs.readFileSync(path.join(sourceDir, resolved), "utf8");
          const subEndpoints = extractFromFileContent(routerContent, resolved, sourceDir);
          for (const subEp of subEndpoints) {
            const subPath = subEp.path === "/" ? "" : subEp.path;
            subEp.path = prefix.replace(/\/$/, "") + subPath;
            subEp.filePath = resolved;
            subEp.confidence = subEp.confidence || "low";
            endpoints.push(subEp);
          }
        }
      }
    }

    // Also try to detect named export functions that look like controllers
    // and associate them with routes by import relationships - basic heuristic
    const namedHandlers = [];
    const handlerRegex = /export\s+(?:const|function|async\s+function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let hm;
    while ((hm = handlerRegex.exec(content)) !== null) {
      namedHandlers.push({ name: hm[1], line: findLineNumber(content, hm.index) });
    }

    // For each route without handler, try to infer from named exports in same file
    for (const ep of endpoints) {
      if (!ep.handler && namedHandlers.length > 0) {
        // Simple heuristic: if only one named handler exists, link it
        if (namedHandlers.length === 1) {
          ep.handler = namedHandlers[0].name;
          ep.confidence = "low";
        }
      }
    }
  } else if (framework === "flask_fastapi") {
    // Basic Python detection for Flask / FastAPI routes
    const flaskRegex = /(?:@.*\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods=\[([^\]]+)\])?\s*\)|@app\.route\s*\(\s*['"]([^'"]+)['"])/gi;
    // Note: regex above is simplified; we use a line-oriented scan instead
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const routeMatch = line.match(/@(app|router)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods=\[([^\]]*)\])?\s*\)/);
      if (routeMatch) {
        const rawPath = routeMatch[2];
        const methodsStr = routeMatch[3] ? routeMatch[3].trim() : "GET";
        const pathStr = normalizeRoutePath(rawPath);
        // Look for handler function name on next non-empty line
        let handlerName = null;
        for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
          const nextLine = lines[j].trim();
          if (!nextLine || nextLine.startsWith("#")) continue;
          const defMatch = nextLine.match(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
          if (defMatch) {
            handlerName = defMatch[1];
            break;
          }
          // Stop scanning if we hit another decorator or non-definition
          if (nextLine.startsWith("@") || nextLine.match(/^(return|if|while|for|print)/)) {
            // Check a bit further for function definition
            for (let k = j; k < Math.min(j + 5, lines.length); k++) {
              const deep = lines[k].trim();
              const deepDef = deep.match(/def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
              if (deepDef) {
                handlerName = deepDef[1];
                j = k;
                break;
              }
            }
            break;
          }
        }
        const methods = methodsStr ? methodsStr.split(",").map(s => s.trim().replace(/['"]/g, "").toUpperCase()).filter(Boolean) : ["GET"];
        for (const method of methods) {
          if (HTTP_METHODS.has(method)) {
            endpoints.push({
              framework: "flask_fastapi",
              method,
              path: pathStr,
              handler: handlerName,
              filePath: relativePath,
              startLine: i + 1,
              endLine: i + (handlerName ? 10 : 2),
              confidence: handlerName ? "high" : "medium",
            });
          }
        }
      }
    }
  }

  return endpoints;
}

function isRoutePath(p) {
  return !/\s/.test(p) && (p.startsWith("/") || p === "*" || /^[\w:.*-]+(\/|$)/.test(p));
}

function normalizeRoutePath(p) {
  if (p.startsWith("/")) return p;
  return "/" + p;
}

function resolveHandlerName(raw, content, filePath) {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (cleaned.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
    return cleaned;
  }
  // If it looks like an arrow function assignment, skip
  if (cleaned.includes("=>")) return null;
  // If it references an import like `handler`, use that name
  return cleaned.split(".")[0] || cleaned;
}

function findLineNumber(content, index) {
  const before = content.substring(0, index);
  return before.split("\n").length;
}

// ------------------------------------------------------------------
// Call-path tracing
// ------------------------------------------------------------------

export function traceFlow(endpoints, fileDir, maxDepth = 4, maxResults = 30) {
  // We use a simple heuristic: for each endpoint handler name,
  // scan the repository files for function definitions with that name,
  // then follow import links from that file to downstream functions.
  const graph = buildCallGraph(fileDir);
  const endpoint = endpoints[0]; // for simplicity, take first endpoint
  if (!endpoint) {
    return { entry: null, paths: [], partial: true, note: "No endpoint provided" };
  }

  const entryNode = buildTraceNode(endpoint);
  let paths = [];

  // Find source file containing the handler
  const handlerFile = endpoint.filePath ? path.join(fileDir, endpoint.filePath) : null;

  // Start from handler; traverse downstream using import/call relationships
  const visited = new Set();
  const stack = [{ node: entryNode, depth: 0, path: [entryNode] }];

  while (stack.length > 0) {
    const { node, depth, path } = stack.pop();
    const nodeKey = `${node.name}:${node.filePath}:${node.line}`;
    if (visited.has(nodeKey)) {
      // If we've already explored this exact node, don't expand again,
      // but keep the path record (branching handled by tracking paths separately)
      paths.push({ steps: [...path], depth: path.length - 1, complete: depth >= 0 });
      continue;
    }
    if (depth >= maxDepth) {
      paths.push({ steps: [...path], depth: path.length - 1, complete: false, note: "Reached max depth" });
      continue;
    }

    visited.add(nodeKey);

    // Find downstream calls
    const downstream = findDownstreamCalls(node, graph, fileDir);

    if (downstream.length === 0) {
      // Terminal node
      paths.push({ steps: [...path], depth: path.length - 1, complete: true, note: "Terminal" });
    } else {
      for (const child of downstream) {
        const newPath = [...path, child];
        stack.push({ node: child, depth: depth + 1, path: newPath });
        paths.push({ steps: newPath, depth: newPath.length - 1, complete: false, branches: true });
      }
    }

    // Limit total paths to prevent explosion
    if (paths.length > maxResults) {
      paths = paths.slice(0, maxResults);
      break;
    }
  }

  // Deduplicate paths by step sequence
  const seenPaths = new Set();
  const uniquePaths = [];
  for (const p of paths) {
    const key = p.steps.map(s => `${s.name}:${s.filePath}:${s.line}`).join("|");
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      uniquePaths.push(p);
    }
  }

  const partial = uniquePaths.length === 0 || uniquePaths.some(p => !p.complete);

  return {
    entry: entryNode,
    paths: uniquePaths,
    partial,
    note: partial ? "Partial resolution (static analysis limits)" : "Complete trace",
    endpoint,
  };
}

function buildTraceNode(endpoint) {
  return {
    id: `node-${endpoint.path}-${endpoint.method}`.replace(/[^a-zA-Z0-9]/g, "-"),
    label: endpoint.path,
    type: "endpoint",
    name: endpoint.handler || endpoint.path,
    filePath: endpoint.filePath,
    line: endpoint.startLine || 0,
    method: endpoint.method,
    framework: endpoint.framework,
    confidence: endpoint.confidence,
  };
}

function buildCallGraph(sourceDir) {
  // Build a simple call graph from source files using regex heuristics
  const graph = { nodes: new Map(), edges: [] };
  const files = {};

  function visit(dir) {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const item of items) {
      if (IGNORE.has(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) visit(full);
      else if (item.isFile() && /\.(js|ts|jsx|tsx|py)$/.test(item.name)) {
        const rel = path.relative(sourceDir, full).replace(/\\/g, "/");
        files[rel] = full;
        try {
          const content = fs.readFileSync(full, "utf8");
          // Find all function definitions
          const funcs = [...content.matchAll(/(?:function|const|export\s+function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)];
          for (const f of funcs) {
            const name = f[1];
            if (!graph.nodes.has(name)) {
              graph.nodes.set(name, { files: new Set(), lines: [] });
            }
            graph.nodes.get(name).files.add(rel);
            graph.nodes.get(name).lines.push(findLineNumber(content, f.index));
          }
        } catch (e) {
          // skip unreadable
        }
      }
    }
  }
  visit(sourceDir);
  return { graph, files };
}

function findDownstreamCalls(node, callGraph, fileDir) {
  const downstream = [];
  const handlerName = node.name || node.label;
  const fileKey = node.filePath ? node.filePath : null;

  // Strategy 1: Scan the handler file for service/repository imports,
  // then resolve those imports and extract their exported class methods.
  if (fileKey) {
    const handlerFull = path.join(fileDir, fileKey);
    let handlerContent = "";
    try {
      handlerContent = fs.readFileSync(handlerFull, "utf8");
    } catch (e) {}

    const importMatches = [...handlerContent.matchAll(/from\s+['"](.+?)['"]/g)];
    for (const imp of importMatches) {
      const importPath = imp[1];
      const baseDir = path.dirname(handlerFull);
      const resolvedRel = resolveImportToFile(importPath, baseDir, fileDir);
      if (resolvedRel) {
        const resolvedFull = path.join(fileDir, resolvedRel);
        let resolvedContent = "";
        try {
          resolvedContent = fs.readFileSync(resolvedFull, "utf8");
        } catch (e) {}

        // Extract exported class methods (service/repository pattern)
        const classRegex = /export\s+(?:class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
        const classMatches = [...resolvedContent.matchAll(classRegex)];
        for (const cls of classMatches) {
          const clsName = cls[1];
          // Find method definitions within the class (heuristic: def following class definition)
          const afterClassIndex = cls.index + cls[0].length;
          const afterClassText = resolvedContent.substring(afterClassIndex, Math.min(afterClassIndex + 1500, resolvedContent.length));
          const methodRegex = /(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
          const methodMatches = [...afterClassText.matchAll(methodRegex)];
          for (const mm of methodMatches) {
            const methodName = mm[1];
            // Skip constructor
            if (methodName === "constructor" || methodName === clsName) continue;
            // Skip common non-service names
            if (["toString", "valueOf", "init", "setup"].includes(methodName)) continue;
            const child = {
              id: `node-${clsName}-${methodName}-${resolvedRel}`.replace(/[^a-zA-Z0-9]/g, "-"),
              label: `${clsName}.${methodName}`,
              type: "service",
              name: `${clsName}.${methodName}`,
              filePath: resolvedRel,
              line: findLineNumber(resolvedContent, mm.index) || 0,
              confidence: "low",
              framework: resolvedRel.endsWith(".py") ? "python" : "express",
            };
            const exists = downstream.some(
              (d) => d.id === child.id && d.filePath === child.filePath && d.line === child.line
            );
            if (!exists) downstream.push(child);
          }
        }
      }
    }
  }

  // Strategy 2: Only resolve downstream references that are actually mentioned
  // in the controller file through import or direct usage. Do NOT scan all files.
  // Only scan files that are directly imported by the controller.
  const fileList = Object.keys(callGraph.files);
  const controllerImports = new Set();
  if (fileKey) {
    const controllerFull = path.join(fileDir, fileKey);
    try {
      const controllerContent = fs.readFileSync(controllerFull, "utf8");
      const importMatches = [...controllerContent.matchAll(/from\s+['"](.+?)['"]/g)];
      for (const imp of importMatches) {
        const importPath = imp[1];
        const baseDir = path.dirname(controllerFull);
        const resolvedRel = resolveImportToFile(importPath, baseDir, fileDir);
        if (resolvedRel) controllerImports.add(resolvedRel);
      }
    } catch (e) {}
  }

  // Only scan files that the controller actually imports
  for (const fileRel of fileList) {
    if (!controllerImports.has(fileRel) && fileRel !== fileKey) continue;
    const fullFile = callGraph.files[fileRel];
    let contentFile = "";
    try {
      contentFile = fs.readFileSync(fullFile, "utf8");
    } catch (e) {
      continue;
    }
    // Find exported classes and add their methods as verified downstream nodes
    const classRegex = /export\s+(?:class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
    const classMatches = [...contentFile.matchAll(classRegex)];
    for (const cls of classMatches) {
      const clsName = cls[1];
      const afterClassText = contentFile.substring(cls.index + cls[0].length, Math.min(cls.index + cls[0].length + 1500, contentFile.length));
      const methodMatches = [...afterClassText.matchAll(/(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)];
      for (const mm of methodMatches) {
        const methodName = mm[1];
        if (methodName === "constructor" || methodName === clsName) continue;
        if (["toString", "valueOf", "init", "setup"].includes(methodName)) continue;
        const child = {
          id: `node-${clsName}-${methodName}-${fileRel}`.replace(/[^a-zA-Z0-9]/g, "-"),
          label: `${clsName}.${methodName}`,
          type: fileRel.includes("service") || fileRel.includes("controller") ? "service" : fileRel.includes("repository") || fileRel.includes("repo") ? "repository" : "function",
          name: `${clsName}.${methodName}`,
          filePath: fileRel,
          line: findLineNumber(contentFile, mm.index) || 0,
          confidence: fileRel.includes("service") ? "medium" : fileRel.includes("repo") ? "low" : "low",
          framework: fileRel.endsWith(".py") ? "python" : "express",
        };
        const exists = downstream.some((d) => d.id === child.id && d.filePath === child.filePath && d.line === child.line);
        if (!exists) downstream.push(child);
      }
    }
  }

  return downstream.slice(0, 6);
}

function resolveImportToFile(importPath, baseDir, sourceDir) {
  // If import already includes an extension, also try stripping it
  const baseWithoutExt = importPath.endsWith(".js") ? importPath.slice(0, -3) : importPath.endsWith(".ts") ? importPath.slice(0, -3) : importPath;
  const candidates = [
    importPath,
    baseWithoutExt + ".js",
    baseWithoutExt + ".ts",
    baseWithoutExt,
    importPath + ".ts",
  ];
  const possiblePaths = [];
  for (const cand of candidates) {
    possiblePaths.push(path.resolve(baseDir, cand));
    possiblePaths.push(path.resolve(baseDir, cand, "index.js"));
    possiblePaths.push(path.resolve(baseDir, cand, "index.ts"));
  }
  const uniquePaths = [...new Set(possiblePaths)];
  for (const p of uniquePaths) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return path.relative(sourceDir, p).replace(/\\/g, "/");
    }
  }
  return null;
}

function extractFromFileContent(content, relativePath, sourceDir) {
  // Reuse the express extraction logic on content
  const endpoints = [];
  const framework = relativePath.endsWith(".py") ? "flask_fastapi" : "express";

  if (framework === "express") {
    const routeRegex = /(?:app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*([^)]+))?\)/gi;
    let m;
    while ((m = routeRegex.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      if (method === "USE") continue;
      const rawPath = m[2];
      if (!isRoutePath(rawPath)) continue;
      const handlerRaw = m[3] ? m[3].trim() : null;
      const pathStr = normalizeRoutePath(rawPath);
      const handlerName = resolveHandlerName(handlerRaw, content, relativePath);
      endpoints.push({
        framework: "express",
        method: method === "ALL" ? "ALL" : method,
        path: pathStr,
        handler: handlerName,
        filePath: relativePath,
        startLine: findLineNumber(content, m.index),
        endLine: findLineNumber(content, m.index) + 1,
        confidence: handlerName ? "high" : "medium",
      });
    }
    const chainRegex = /router\.route\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let chainDef;
    while ((chainDef = chainRegex.exec(content)) !== null) {
      const routePath = normalizeRoutePath(chainDef[1]);
      const afterIndex = chainRegex.lastIndex;
      const afterText = content.substring(afterIndex, Math.min(afterIndex + 300, content.length));
      const chainedMethods = [...afterText.matchAll(/\.(get|post|put|patch|delete|all)\s*\(([^)]+)\)/gi)];
      for (const cm of chainedMethods) {
        const method = cm[1].toUpperCase();
        if (!HTTP_METHODS.has(method)) continue;
        const handlerRaw = cm[2] ? cm[2].trim() : null;
        const handlerName = resolveHandlerName(handlerRaw, content, relativePath);
        endpoints.push({
          framework: "express",
          method: method === "ALL" ? "ALL" : method,
          path: routePath,
          handler: handlerName,
          filePath: relativePath,
          startLine: findLineNumber(content, chainDef.index),
          endLine: findLineNumber(content, chainDef.index) + 5,
          confidence: handlerName ? "high" : "medium",
        });
      }
    }
  }
  return endpoints;
}
