/** Visual vocabulary for the API flow view, aligned with the app's dark / ember palette. */
export const METHOD_COLORS: Record<string, string> = {
  GET: "#4ade80",
  POST: "#f59e0b",
  PUT: "#3b82f6",
  PATCH: "#a855f7",
  DELETE: "#ef4444",
  ALL: "#ff5330",
  OPTIONS: "#a8a29e",
  HEAD: "#a8a29e",
};

export type KindMeta = { label: string; color: string; bg: string; description: string };

export const KIND_META: Record<string, KindMeta> = {
  endpoint: { label: "Endpoint", color: "#60a5fa", bg: "#111a26", description: "The HTTP route where the request enters the app." },
  middleware: { label: "Middleware", color: "#f5b347", bg: "#1d1710", description: "Runs before the handler: parsing, auth, validation, logging." },
  handler: { label: "Handler", color: "#ff5330", bg: "#1e1311", description: "The route handler that serves this request." },
  controller: { label: "Controller", color: "#ff7a3d", bg: "#1e1411", description: "Controller-layer function called by the handler." },
  service: { label: "Service", color: "#a855f7", bg: "#191223", description: "Business logic in a service module or class." },
  data: { label: "Data layer", color: "#4ade80", bg: "#0f1a12", description: "Repository / model / data-access code in the project." },
  utility: { label: "Utility", color: "#a8a29e", bg: "#161413", description: "Helper or utility function." },
  function: { label: "Function", color: "#c4b5a5", bg: "#161312", description: "Project function reached on this path." },
  database: { label: "Database", color: "#4ade80", bg: "#0f1a12", description: "A database / model / cache operation." },
  external: { label: "External", color: "#22d3ee", bg: "#0e1a1d", description: "A call that leaves the app: HTTP, auth, 3rd-party SDK." },
  response: { label: "Response", color: "#4ade80", bg: "#121614", description: "Where an HTTP response is sent back to the client." },
  error: { label: "Error", color: "#ef4444", bg: "#1f1010", description: "Passes an error to the error-handling middleware." },
};

/** Legend groups used for show/hide filters. */
export const LEGEND_GROUPS: { id: string; label: string; color: string }[] = [
  { id: "middleware", label: "Middleware", color: KIND_META.middleware.color },
  { id: "handler", label: "Handler", color: KIND_META.handler.color },
  { id: "logic", label: "Logic", color: KIND_META.service.color },
  { id: "data", label: "Data", color: KIND_META.database.color },
  { id: "external", label: "External", color: KIND_META.external.color },
  { id: "response", label: "Response", color: "#86efac" },
];

export function statusColor(status: number | string | undefined): string {
  if (typeof status !== "number") return "#a8a29e";
  if (status < 300) return "#4ade80";
  if (status < 400) return "#60a5fa";
  if (status < 500) return "#f5b347";
  return "#ef4444";
}

export function edgeColor(kind: string): string {
  switch (kind) {
    case "queries": return "#4ade80";
    case "external": return "#22d3ee";
    case "responds": return "#4ade80";
    case "error": return "#ef4444";
    case "next": return "#f5b347";
    case "handles": return "#ff8c6b";
    default: return "#5b4a44";
  }
}

export const EDGE_VERB: Record<string, string> = {
  next: "then",
  handles: "handled by",
  calls: "calls",
  queries: "queries",
  external: "calls out to",
  responds: "responds",
  error: "on error",
};

export function shortFile(f: string | undefined | null): string {
  if (!f) return "";
  const parts = f.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : f;
}

export function nodeColor(n: { kind: string; status?: number | string } | undefined): string {
  if (!n) return "#a8a29e";
  return n.kind === "response" ? statusColor(n.status) : (KIND_META[n.kind] || KIND_META.function).color;
}
