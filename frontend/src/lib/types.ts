export type GraphNode = { id: string; lines?: number };
export type GraphLink = { source: string; target: string };
export type GraphData = { nodes: GraphNode[]; links: GraphLink[]; backLinks?: Record<string, string[]> };

export type CycleItem = { id: string; path: string[]; formatted: string; size?: number };
export type DeadCodeItem = { file: string; inDegree: number; lines: number };
export type CouplingItem = { file: string; fanIn: number; fanOut: number; score: number; severity: "HIGH" | "CRITICAL" };

export type DiagnosticsData = {
  healthScore: number;
  summary: { totalIssues: number; circularCount: number; deadCodeCount: number; tightCouplingCount: number };
  diagnostics: { circularDependencies: CycleItem[]; deadCode: DeadCodeItem[]; tightCouplings: CouplingItem[] };
};

export type Endpoint = {
  framework: string;
  method: string;
  path: string;
  handler: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  confidence: string;
  id?: string;
  routePath?: string;
  handlerFile?: string | null;
  handlerLine?: number | null;
  middleware?: string[];
  mountChain?: { file: string; line: number; prefix: string }[];
  mountResolved?: boolean;
};

export type FlowNodeKind =
  | "endpoint" | "middleware" | "handler" | "controller" | "service" | "data" | "utility" | "function"
  | "database" | "external" | "response" | "error";

export type FlowNode = {
  id: string;
  kind: FlowNodeKind | string;
  name: string;
  filePath: string;
  line: number;
  endLine?: number;
  depth?: number;
  resolution: "resolved" | "pattern" | "unresolved";
  async?: boolean;
  params?: string[];
  wrapper?: string | null;
  inline?: boolean;
  truncated?: string;
  callsNext?: boolean;
  unresolved?: { label: string; line: number; reason: string }[];
  libraryCalls?: string[];
  status?: number | string;
  statusImplicit?: boolean;
  sender?: string;
  category?: string;
  package?: string | null;
  model?: string | null;
  detail?: string;
  method?: string;
  path?: string;
  framework?: string;
  factoryName?: string;
  mountChain?: { file: string; line: number; prefix: string }[];
  mountResolved?: boolean;
  /** Source text of the definition / registration line (evidence) */
  signature?: string | null;
  /** Leading doc comment or docstring from the source */
  doc?: string | null;
  /** Frontend-only: ids of middleware merged into a group node */
  members?: string[];
};

export type FlowEdge = {
  id: string;
  from: string;
  to: string;
  kind: "next" | "handles" | "calls" | "queries" | "external" | "responds" | "error" | string;
  order: number;
  count: number;
  lines: number[];
  label: string | null;
  conditional: boolean;
  async: boolean;
  /** File that contains the connecting line(s) */
  file?: string | null;
  /** Source text of the first connecting line */
  snippet?: string | null;
  /** How the connection is made: import binding, route registration, middleware registration… */
  via?: EdgeVia | null;
};

export type EdgeVia =
  | { kind: "import" | "package"; expr: string; local: string; spec: string; imported: string; importLine: number; importFile: string; importText?: string | null; resolvedFile?: string | null; defFile?: string | null }
  | { kind: "same-file" | "instance"; expr?: string; local: string; className?: string; defFile?: string | null }
  | { kind: "this-method"; expr?: string; local?: string }
  | { kind: "instance-field"; expr: string; field: string }
  | { kind: "local"; expr: string; local: string; line: number }
  | { kind: "expression"; expr: string }
  | { kind: "middleware"; scope: { level: "app" | "router" | "route" | "decorator"; router: string | null; prefix: string | null } | null }
  | { kind: "route"; handlerLabel: string | null; wrapper?: string | null; defFile?: string }
  | { kind: "decorator" }
  | { kind: "response"; sender: string; param: string }
  | { kind: "next-error"; param: string }
  | { kind: "throw" };

export type AnalysisNote = {
  id: string;
  severity: "info" | "warn";
  title: string;
  detail: string;
  hint?: string;
  nodeIds?: string[];
};

export type FlowTrace = {
  endpoint: Endpoint;
  entryId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  stats: { nodes: number; edges: number; counts: Record<string, number>; maxDepth: number; unresolved: number };
  truncated: boolean;
  partial: boolean;
  warnings: string[];
  notes?: AnalysisNote[];
  analysis?: { kind: "static"; description: string };
  ms?: number;
};

/** Nodes to emphasise on the canvas; everything else is dimmed. */
export type Highlight = {
  kind: "impact" | "cycle";
  source?: string;
  ids: Set<string>;
  depth: Map<string, number>;
  /** Directed links (source->target keys) to animate. */
  links: Set<string>;
};

export type ImpactResult = {
  source: string;
  /** `proximity` decays with every hop from the changed file (1 = the file itself). */
  affected: { id: string; depth: number; proximity: number; isTest: boolean; endpoints: Endpoint[] }[];
  files: number;
  /** Sum of proximity over all dependents: a distance-weighted blast radius. */
  weightedImpact: number;
  tests: string[];
  apis: Endpoint[];
  maxDepth: number;
  riskScore: number;
  riskLabel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  highlight: Highlight;
};

export type GraphHandle = {
  /** PNG data URL of the whole graph, fitted to content, at `scale`x resolution. */
  snapshot: (scale?: number) => string | null;
  /** Fit the whole graph into view. */
  zoomToFit: () => void;
};
