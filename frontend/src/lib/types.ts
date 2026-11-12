export type GraphNode = { id: string; lines?: number };
export type GraphLink = { source: string; target: string };
export type GraphData = { nodes: GraphNode[]; links: GraphLink[]; backLinks?: Record<string, string[]> };

export type CycleItem = { id: string; path: string[]; formatted: string };
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
  affected: { id: string; depth: number; isTest: boolean; endpoints: Endpoint[] }[];
  files: number;
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
