import type { DiagnosticsData, Endpoint, GraphData, ImpactResult } from "./types";
import { buildAdjacency, isTestFile } from "./graphAnalysis";

/**
 * Multi-page executive architecture audit (A4, dark theme).
 * jsPDF and html2canvas are loaded on demand so they never weigh on page load.
 */

type ReportInput = {
  repoUrl: string;
  graph: GraphData;
  diagnostics: DiagnosticsData | null;
  endpoints: Endpoint[];
  impact: ImpactResult | null;
  graphImage: string | null; // PNG data URL of the node graph
  sunburstImage: string | null; // PNG data URL of the sunburst
  fallbackElement?: HTMLElement | null; // captured with html2canvas when no image is available
};

const W = 210;
const H = 297;
const M = 16;
const C = {
  bg: [12, 10, 9] as const,
  panel: [24, 20, 19] as const,
  border: [46, 42, 39] as const,
  coral: [255, 83, 48] as const,
  peach: [255, 217, 188] as const,
  text: [236, 228, 221] as const,
  muted: [150, 138, 130] as const,
  green: [52, 211, 153] as const,
  amber: [251, 191, 36] as const,
  red: [248, 113, 113] as const,
};

export async function exportAuditReport(input: ReportInput) {
  const [{ jsPDF }] = await Promise.all([import("jspdf")]);
  const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4", compress: true });

  const d = input.diagnostics;
  const score = d?.healthScore ?? 0;
  const repoName = input.repoUrl.replace(/^https?:\/\/github\.com\//, "") || "repository";
  const generated = new Date();
  const adj = buildAdjacency(input.graph);
  const totalLines = input.graph.nodes.reduce((s, n) => s + (n.lines || 0), 0);
  const deadLines = (d?.diagnostics.deadCode || []).reduce((s, x) => s + (x.lines || 0), 0);
  const testFiles = input.graph.nodes.filter((n) => isTestFile(n.id)).length;

  // ---------------------------------------------------------------- helpers
  const fill = (c: readonly number[]) => pdf.setFillColor(c[0], c[1], c[2]);
  const stroke = (c: readonly number[]) => pdf.setDrawColor(c[0], c[1], c[2]);
  const color = (c: readonly number[]) => pdf.setTextColor(c[0], c[1], c[2]);
  const bg = () => {
    fill(C.bg);
    pdf.rect(0, 0, W, H, "F");
  };
  let y = M;
  const newPage = (title?: string) => {
    pdf.addPage();
    bg();
    y = M;
    if (title) sectionTitle(title);
  };
  const ensure = (needed: number, title?: string) => {
    if (y + needed > H - 20) newPage(title ? `${title} (cont.)` : undefined);
  };
  const sectionTitle = (title: string, kicker?: string) => {
    if (kicker) {
      color(C.coral);
      pdf.setFont("courier", "bold");
      pdf.setFontSize(8);
      pdf.text(kicker.toUpperCase(), M, y);
      y += 6;
    }
    color(C.text);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.text(title, M, y + 2);
    y += 6;
    fill(C.coral);
    pdf.rect(M, y, 18, 0.8, "F");
    y += 8;
  };
  const para = (text: string, size = 10, c: readonly number[] = C.muted) => {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(size);
    color(c);
    const lines = pdf.splitTextToSize(text, W - M * 2) as string[];
    ensure(lines.length * size * 0.45);
    pdf.text(lines, M, y);
    y += lines.length * size * 0.42 + 3;
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, width: number, c: readonly number[]) => {
    stroke(c);
    pdf.setLineWidth(width);
    pdf.setLineCap("round");
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.06));
    let px = cx + r * Math.cos(a0);
    let py = cy + r * Math.sin(a0);
    for (let i = 1; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const nx = cx + r * Math.cos(a);
      const ny = cy + r * Math.sin(a);
      pdf.line(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  };
  const table = (
    title: string,
    cols: { label: string; w: number; align?: "left" | "right" }[],
    rows: string[][],
    emptyText: string
  ) => {
    ensure(24);
    const drawHead = () => {
      fill(C.panel);
      pdf.rect(M, y - 4.5, W - M * 2, 7, "F");
      pdf.setFont("courier", "bold");
      pdf.setFontSize(7.5);
      color(C.muted);
      let x = M + 2;
      for (const c of cols) {
        pdf.text(c.label.toUpperCase(), c.align === "right" ? x + c.w - 4 : x, y, { align: c.align === "right" ? "right" : "left" });
        x += c.w;
      }
      y += 6;
    };
    drawHead();
    if (!rows.length) {
      pdf.setFont("helvetica", "italic");
      pdf.setFontSize(9);
      color(C.green);
      pdf.text(emptyText, M + 2, y + 1);
      y += 10;
      return;
    }
    pdf.setFont("courier", "normal");
    pdf.setFontSize(8);
    rows.forEach((r, ri) => {
      const wrapped = r.map((cell, ci) => pdf.splitTextToSize(cell, cols[ci].w - 4) as string[]);
      const lines = Math.max(...wrapped.map((w) => w.length));
      const rowH = lines * 3.6 + 2.4;
      if (y + rowH > H - 20) {
        newPage(`${title} (cont.)`);
        drawHead();
        pdf.setFont("courier", "normal");
        pdf.setFontSize(8);
      }
      if (ri % 2 === 1) {
        fill([18, 15, 14]);
        pdf.rect(M, y - 3.6, W - M * 2, rowH, "F");
      }
      let x = M + 2;
      wrapped.forEach((cell, ci) => {
        color(ci === 0 ? C.text : C.muted);
        const c = cols[ci];
        pdf.text(cell, c.align === "right" ? x + c.w - 4 : x, y, { align: c.align === "right" ? "right" : "left" });
        x += c.w;
      });
      y += rowH;
    });
    y += 6;
  };

  // ================================================================ PAGE 1
  bg();
  // Accent glow block
  fill([28, 16, 13]);
  pdf.rect(0, 0, W, 96, "F");
  fill(C.coral);
  pdf.rect(0, 96, W, 0.8, "F");

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(13);
  color(C.text);
  pdf.text("Code", M, 20);
  color(C.coral);
  pdf.text("Lens", M + pdf.getTextWidth("Code"), 20);

  color(C.coral);
  pdf.setFont("courier", "bold");
  pdf.setFontSize(8);
  pdf.text("ARCHITECTURE AUDIT REPORT", M, 44);
  color(C.text);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(26);
  const titleLines = pdf.splitTextToSize(repoName, 120) as string[];
  pdf.text(titleLines.slice(0, 2), M, 56);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9.5);
  color(C.muted);
  pdf.text(input.repoUrl || "", M, 56 + titleLines.slice(0, 2).length * 10);
  pdf.text(`Generated ${generated.toLocaleString()}`, M, 62 + titleLines.slice(0, 2).length * 10);

  // Health gauge
  const gx = 160;
  const gy = 56;
  const scoreColor = score >= 80 ? C.green : score >= 50 ? C.amber : C.red;
  arc(gx, gy, 22, Math.PI * 0.75, Math.PI * 2.25, 4, C.border);
  arc(gx, gy, 22, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * (score / 100), 4, scoreColor);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(26);
  color(C.text);
  pdf.text(String(score), gx, gy + 3, { align: "center" });
  pdf.setFontSize(8);
  color(C.muted);
  pdf.text("/ 100  HEALTH", gx, gy + 10, { align: "center" });
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  pdf.setFont("courier", "bold");
  color(scoreColor);
  pdf.text(`GRADE ${grade}`, gx, gy + 28, { align: "center" });

  // KPI cards
  y = 108;
  const kpis = [
    { k: "Files", v: input.graph.nodes.length.toLocaleString() },
    { k: "Dependencies", v: input.graph.links.length.toLocaleString() },
    { k: "Lines of code", v: totalLines.toLocaleString() },
    { k: "Endpoints", v: String(input.endpoints.length) },
    { k: "Circular deps", v: String(d?.summary.circularCount ?? 0), c: (d?.summary.circularCount ?? 0) ? C.red : C.green },
    { k: "God modules", v: String(d?.summary.tightCouplingCount ?? 0), c: (d?.summary.tightCouplingCount ?? 0) ? C.amber : C.green },
    { k: "Dead files", v: String(d?.summary.deadCodeCount ?? 0), c: (d?.summary.deadCodeCount ?? 0) ? C.amber : C.green },
    { k: "Test files", v: String(testFiles) },
  ];
  const cw = (W - M * 2 - 9) / 4;
  kpis.forEach((kp, i) => {
    const x = M + (i % 4) * (cw + 3);
    const yy = y + Math.floor(i / 4) * 25;
    fill(C.panel);
    stroke(C.border);
    pdf.setLineWidth(0.2);
    pdf.roundedRect(x, yy, cw, 21, 2, 2, "FD");
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    color(kp.c || C.text);
    pdf.text(kp.v, x + 4, yy + 10);
    pdf.setFont("courier", "normal");
    pdf.setFontSize(7);
    color(C.muted);
    pdf.text(kp.k.toUpperCase(), x + 4, yy + 16.5);
  });
  y += 58;

  sectionTitle("Executive summary", "Overview");
  const verdict =
    score >= 80
      ? "The architecture is in good shape: modules are well separated and structural risks are limited."
      : score >= 50
        ? "The architecture needs attention: several structural issues raise the cost and risk of change."
        : "The architecture is at risk: structural issues are widespread and should be addressed before major feature work.";
  para(
    `${verdict} CodeLens analysed ${input.graph.nodes.length} source files and ${input.graph.links.length} internal import relationships. ` +
      `It found ${d?.summary.circularCount ?? 0} circular dependency chain(s), ${d?.summary.tightCouplingCount ?? 0} tightly coupled "god" module(s), ` +
      `and ${d?.summary.deadCodeCount ?? 0} file(s) that nothing imports (about ${deadLines.toLocaleString()} lines, ${totalLines ? Math.round((deadLines / totalLines) * 100) : 0}% of the codebase).`,
    10,
    C.text
  );

  const recs: string[] = [];
  if (d?.summary.circularCount) recs.push(`Break the ${d.summary.circularCount} circular chain(s): extract the shared types or logic into a lower-level module both sides can import.`);
  if (d?.summary.tightCouplingCount) recs.push(`Split god modules (highest: ${d.diagnostics.tightCouplings.slice().sort((a, b) => b.score - a.score)[0]?.file}) along responsibility lines to reduce fan-in x fan-out.`);
  if (d?.summary.deadCodeCount) recs.push(`Review the ${d.summary.deadCodeCount} unreferenced file(s); delete confirmed dead code or document why it is an entry point.`);
  if (testFiles === 0) recs.push("No test files were detected. Add regression tests around the most depended-on modules first.");
  if (!recs.length) recs.push("No structural issues detected. Keep the dependency direction consistent as the codebase grows.");
  y += 2;
  color(C.coral);
  pdf.setFont("courier", "bold");
  pdf.setFontSize(8);
  pdf.text("RECOMMENDED ACTIONS", M, y);
  y += 5;
  recs.forEach((r, i) => para(`${i + 1}.  ${r}`, 9.5, C.text));

  // ================================================================ PAGE 2: snapshot
  let graphImage = input.graphImage;
  if (!graphImage && input.fallbackElement) {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(input.fallbackElement, { backgroundColor: "#0c0a09", scale: 2, logging: false });
    graphImage = canvas.toDataURL("image/png");
  }
  if (graphImage) {
    newPage();
    sectionTitle("Dependency graph", "Architecture snapshot");
    const props = pdf.getImageProperties(graphImage);
    const iw = W - M * 2;
    const ih = Math.min(170, (iw * props.height) / props.width);
    stroke(C.border);
    pdf.setLineWidth(0.3);
    pdf.addImage(graphImage, "PNG", M, y, iw, ih, undefined, "FAST");
    pdf.rect(M, y, iw, ih, "S");
    y += ih + 8;
    para("Each node is a source file, sized by lines of code and connectivity. Edges point from the importing file to the file it imports. Colours mark file roles: components (coral), pages and routes (peach), services and models (amber), utilities (stone), tests (teal).", 9);
  }
  if (input.sunburstImage) {
    newPage();
    sectionTitle("Dependency layers", "Sunburst view");
    const s = 150;
    pdf.addImage(input.sunburstImage, "PNG", (W - s) / 2, y, s, s, undefined, "FAST");
    y += s + 8;
    para("Core modules that import nothing internal sit at the centre. Each ring outward depends only on rings inside it, so the outer ring holds entry points and peripheral code. Isolated files form the outermost ring.", 9);
  }

  // ================================================================ DETAIL PAGES
  newPage();
  sectionTitle("Circular dependencies", "Findings");
  para("Import cycles make modules impossible to change or test in isolation and can cause load-order bugs.", 9);
  table(
    "Circular dependencies",
    [
      { label: "#", w: 10 },
      { label: "Cycle", w: W - M * 2 - 26 },
      { label: "Files", w: 16, align: "right" },
    ],
    (d?.diagnostics.circularDependencies || []).map((c, i) => [String(i + 1), c.path.join("  ->  "), String(new Set(c.path).size)]),
    "No circular dependencies detected."
  );

  ensure(70);
  sectionTitle("Tight coupling / god modules", "Findings");
  para("Coupling score = fan-in x fan-out. High scores mark files that many others depend on and that themselves depend on many others.", 9);
  table(
    "God modules",
    [
      { label: "File", w: W - M * 2 - 76 },
      { label: "Fan-in", w: 18, align: "right" },
      { label: "Fan-out", w: 18, align: "right" },
      { label: "Score", w: 18, align: "right" },
      { label: "Severity", w: 22 },
    ],
    (d?.diagnostics.tightCouplings || [])
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((c) => [c.file, String(c.fanIn), String(c.fanOut), String(c.score), c.severity]),
    "Coupling density is within healthy limits."
  );

  ensure(70);
  sectionTitle("Dead code breakdown", "Findings");
  para(`${d?.summary.deadCodeCount ?? 0} file(s) have no internal importers and are not recognised entry points, totalling ${deadLines.toLocaleString()} lines.`, 9);
  table(
    "Dead code",
    [
      { label: "File", w: W - M * 2 - 44 },
      { label: "Lines", w: 22, align: "right" },
      { label: "Share", w: 22, align: "right" },
    ],
    (d?.diagnostics.deadCode || [])
      .slice()
      .sort((a, b) => b.lines - a.lines)
      .map((x) => [x.file, x.lines.toLocaleString(), totalLines ? `${((x.lines / totalLines) * 100).toFixed(1)}%` : "-"]),
    "No orphaned modules found."
  );

  // Most depended-on modules
  const hubs = [...adj.in.entries()].map(([id, v]) => ({ id, n: v.length })).sort((a, b) => b.n - a.n).slice(0, 10).filter((h) => h.n > 0);
  if (hubs.length) {
    ensure(70);
    sectionTitle("Most depended-on modules", "Hotspots");
    table(
      "Hotspots",
      [
        { label: "File", w: W - M * 2 - 30 },
        { label: "Importers", w: 30, align: "right" },
      ],
      hubs.map((h) => [h.id, String(h.n)]),
      ""
    );
  }

  if (input.impact) {
    const imp = input.impact;
    ensure(70);
    sectionTitle("Change impact simulation", "What-if");
    para(
      `Changing ${imp.source} affects ${imp.files} other file(s) up to ${imp.maxDepth} hop(s) away, including ${imp.apis.length} API endpoint(s) and ${imp.tests.length} test file(s). Risk score: ${imp.riskScore}/100 (${imp.riskLabel}).`,
      10,
      C.text
    );
    table(
      "Impact",
      [
        { label: "Depth", w: 16, align: "right" },
        { label: "File", w: W - M * 2 - 36 },
        { label: "Type", w: 20 },
      ],
      imp.affected.filter((a) => a.depth > 0).map((a) => [String(a.depth), a.id, a.isTest ? "test" : a.endpoints.length ? "api" : "file"]),
      "No dependents."
    );
  }

  if (input.endpoints.length) {
    ensure(70);
    sectionTitle("Discovered API endpoints", "Surface");
    table(
      "Endpoints",
      [
        { label: "Method", w: 20 },
        { label: "Path", w: 60 },
        { label: "Location", w: W - M * 2 - 80 },
      ],
      input.endpoints.slice(0, 200).map((e) => [e.method, e.path, `${e.filePath}:${e.startLine}`]),
      ""
    );
  }

  // ================================================================ footers
  const pages = pdf.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    pdf.setPage(p);
    stroke(C.border);
    pdf.setLineWidth(0.2);
    pdf.line(M, H - 12, W - M, H - 12);
    pdf.setFont("courier", "normal");
    pdf.setFontSize(7);
    color(C.muted);
    pdf.text(`CodeLens · ${repoName}`, M, H - 7);
    pdf.text(`${p} / ${pages}`, W - M, H - 7, { align: "right" });
  }

  const safe = repoName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "repo";
  pdf.save(`CodeLens-Audit-${safe}-${generated.toISOString().slice(0, 10)}.pdf`);
}
