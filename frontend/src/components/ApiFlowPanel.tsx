import React, { useState, useEffect, useMemo } from "react";
import * as d3 from "d3";

const METHOD_COLORS: Record<string, string> = {
  GET: "#4ade80", POST: "#f59e0b", PUT: "#3b82f6", PATCH: "#a855f7", DELETE: "#ef4444", ALL: "#ff5330",
};


type Endpoint = { framework: string; method: string; path: string; handler: string | null; filePath: string; startLine: number; endLine: number; confidence: string; };
type TraceStep = { id: string; label: string; type: string; name: string; filePath: string; line: number; confidence: string; framework?: string; method?: string; path?: string; };
type PathItem = { steps: TraceStep[]; depth: number; complete: boolean; note?: string; branches?: boolean; };

export default function ApiFlowPanel({ apiBase, repoUrl, onInspectFile }: { apiBase: string; repoUrl: string; onInspectFile: (filePath: string) => void; }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEndpoint, setSelectedEndpoint] = useState<Endpoint | null>(null);
  const [traceResult, setTraceResult] = useState<any>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [selectedNode, setSelectedNode] = useState<TraceStep | null>(null);
  const [collapsedSidebar, setCollapsedSidebar] = useState(false);
  const [collapsedDetails, setCollapsedDetails] = useState(false);

  useEffect(() => {
    if (!repoUrl) return;
    setLoadingEndpoints(true);
    fetch(`${apiBase}/endpoints`)
      .then((r) => r.json())
      .then((data) => { setEndpoints(data.endpoints || []); })
      .catch(() => { setEndpoints([]); })
      .finally(() => setLoadingEndpoints(false));
  }, [apiBase, repoUrl]);

  const filteredEndpoints = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return endpoints.filter((ep) => ep.path.toLowerCase().includes(q) || (ep.handler && ep.handler.toLowerCase().includes(q)) || ep.method.toLowerCase().includes(q));
  }, [endpoints, searchQuery]);

  const handleTrace = async (ep: Endpoint) => {
    setSelectedEndpoint(ep);
    setTraceResult(null);
    setSelectedNode(null);
    setLoadingTrace(true);
    try {
      const res = await fetch(`${apiBase}/flow?method=${ep.method}&path=${encodeURIComponent(ep.path)}`);
      const data = await res.json();
      setTraceResult(data);
    } catch {
      setTraceResult({ partial: true, note: "Trace request failed.", paths: [] });
    } finally { setLoadingTrace(false); }
  };

  const { traceNodes, traceLinks } = useMemo(() => {
    if (!traceResult || !traceResult.paths || traceResult.paths.length === 0) return { traceNodes: [], traceLinks: [] };
    const nodeMap = new Map<string, TraceStep>();
    const linkSet = new Set<string>();
    const paths: PathItem[] = traceResult.paths || [];
    if (traceResult.entry) nodeMap.set(traceResult.entry.id, traceResult.entry);
    else if (selectedEndpoint) nodeMap.set("entry", { id: "entry", label: selectedEndpoint.path, type: "endpoint", name: selectedEndpoint.handler || selectedEndpoint.path, filePath: selectedEndpoint.filePath, line: selectedEndpoint.startLine || 0, confidence: selectedEndpoint.confidence || "medium", framework: selectedEndpoint.framework } as TraceStep);
    for (const pathItem of paths) {
      const steps = pathItem.steps || [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!nodeMap.has(step.id)) nodeMap.set(step.id, step);
        if (i > 0) {
          const prev = steps[i - 1];
          linkSet.add(`${prev.id}->${step.id}`);
        }
      }
    }
    return {
      traceNodes: Array.from(nodeMap.values()),
      traceLinks: Array.from(linkSet).map((key) => {
        const [source, target] = key.split("->");
        return { source, target };
      }),
    };
  }, [traceResult, selectedEndpoint]);

  const svgRef = React.useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    if (!svgRef.current || traceNodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Compute layout levels first (before using levelGroups)
    const levels = new Map<string, number>();
    const entryId = traceResult?.entry?.id || (selectedEndpoint ? "entry" : null);
    if (entryId) levels.set(entryId, 0);
    const pathsInfo = (traceResult?.paths || []) as PathItem[];
    for (const p of pathsInfo) {
      const steps = p.steps || [];
      for (let i = 0; i < steps.length; i++) {
        const sid = steps[i].id;
        const dist = i;
        if (!levels.has(sid) || (levels.get(sid) || 0) > dist) levels.set(sid, dist);
      }
    }
    const levelGroups = new Map<number, string[]>();
    for (const [id, lvl] of levels) {
      if (!levelGroups.has(lvl)) levelGroups.set(lvl, []);
      levelGroups.get(lvl)!.push(id);
    }

    // Now compute dimensions using levelGroups
    const width = Math.max(720, Math.min(900, (Math.max(...Array.from(levelGroups.values()).map(a => a.length)) * 170) + 80));
    const height = Math.max(420, Math.min(600, (levelGroups.size) * 110 + 100));
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(30,30)`);
    const positions = new Map<string, { x: number; y: number }>();
    for (const [lvl, ids] of levelGroups) {
      const count = ids.length;
      const spacing = 160;
      const startX = (width - (count - 1) * spacing) / 2 + 20;
      for (let i = 0; i < ids.length; i++) {
        positions.set(ids[i], { x: startX + i * spacing, y: 50 + lvl * 90 });
      }
    }
    const nodeData = traceNodes.map((n: any) => ({ ...n, x: positions.get(n.id)?.x || width / 2, y: positions.get(n.id)?.y || 100 }));

    const linkData = traceLinks.map((l: any) => ({
      source: nodeData.find((n: any) => n.id === (typeof l.source === "string" ? l.source : l.source?.id)) || { x: 0, y: 0 },
      target: nodeData.find((n: any) => n.id === (typeof l.target === "string" ? l.target : l.target?.id)) || { x: 0, y: 0 },
    }));

    g.selectAll("path.link")
      .data(linkData)
      .enter()
      .append("path")
      .attr("d", (d: any) => {
        const sx = d.source.x, sy = d.source.y + 10;
        const tx = d.target.x, ty = d.target.y - 10;
        const mx = (sx + tx) / 2;
        return `M${sx},${sy} C${mx},${sy + 20} ${mx},${ty - 20} ${tx},${ty}`;
      })
      .attr("fill", "none")
      .attr("stroke", (d: any) => d.source.id === selectedNode?.id || d.target.id === selectedNode?.id ? "#ff8c6b" : "rgba(255,83,48,0.2)")
      .attr("stroke-width", (d: any) => d.source.id === selectedNode?.id || d.target.id === selectedNode?.id ? 2.5 : 1)
      .attr("stroke-linecap", "round")
      .attr("opacity", (d: any) => d.source.id === selectedNode?.id || d.target.id === selectedNode?.id ? 1 : 0.35)
      .attr("marker-end", "url(#arrow)");

    const defs = svg.append("defs");
    defs.append("marker").attr("id", "arrow").attr("viewBox", "0 -5 10 10").attr("refX", 10).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto").append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#ff5330");

    const nodeGroup = g.selectAll("g.node").data(nodeData).enter().append("g").attr("class", "node").attr("transform", (d: any) => `translate(${d.x},${d.y})`).style("cursor", "pointer").on("click", (_e: any, d: any) => setSelectedNode(d));

    nodeGroup.append("rect").attr("rx", 8).attr("ry", 8).attr("x", -72).attr("y", -22).attr("width", 144).attr("height", 48)
      .attr("fill", (d: any) => { if (d.type === "endpoint") return "#152538"; if (d.type === "controller") return "#2e1f18"; if (d.type === "service") return "#2b1e36"; if (d.type === "repository") return "#152a15"; return "#161312"; })
      .attr("stroke", (d: any) => { if (d.id === selectedNode?.id) return "#ff8c6b"; if (d.type === "endpoint") return "#4a7dcf"; if (d.type === "controller") return "#ff7a3d"; if (d.type === "service") return "#b070e0"; if (d.type === "repository") return "#6aaa66"; return "#3d3835"; })
      .attr("stroke-width", (d: any) => (d.id === selectedNode?.id ? 2.5 : 1.2))
      .style("filter", (d: any) => d.id === selectedNode?.id ? "drop-shadow(0 0 6px rgba(255,140,107,0.3))" : "none")

    nodeGroup.append("text").text((d: any) => d.label || d.name).attr("text-anchor", "middle").attr("dy", 5).attr("font-size", 11).attr("fill", (d: any) => d.id === selectedNode?.id ? "#fff" : "#e2ddd5").attr("font-family", "monospace");
    nodeGroup.append("text").text((d: any) => { if (d.type === "endpoint") return "Endpoint"; if (d.type === "controller") return "Controller"; if (d.type === "service") return "Service"; if (d.type === "repository") return "Data"; return d.type ? d.type.toUpperCase() : ""; }).attr("text-anchor", "middle").attr("dy", -7).attr("font-size", 7).attr("fill", (d: any) => { if (d.type === "endpoint") return "#3b82f6"; if (d.type === "controller") return "#ff5330"; if (d.type === "service") return "#a855f7"; if (d.type === "repository") return "#4ade80"; return METHOD_COLORS[d.method] || "#8a7975"; }).attr("font-family", "monospace");
  }, [traceNodes, traceLinks, selectedNode, traceResult]);

  return (
    <div className="flex flex-col h-full bg-[#090808] text-stone-200 font-sans selection:bg-[#ff5330]/20">
      <div className="shrink-0 border-b border-[#2a2222]/80 px-5 py-3 flex items-center justify-between bg-[#121110]/90 backdrop-blur-md">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-0.5">
            <h2 className="text-base font-bold tracking-wide text-[#ff5330] font-mono">Static API Flow Analysis</h2>
            <span className="text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded bg-[#ff5330]/15 text-[#ff8c6b] border border-[#ff5330]/20">Inferred</span>
          </div>
          <p className="text-[10px] text-stone-500 font-mono leading-snug">Follow the selected endpoint through its statically reachable function calls.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setCollapsedSidebar(!collapsedSidebar)} className="text-[10px] px-2.5 py-1 rounded-md bg-[#1d1918] text-stone-400 border border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40 transition font-mono shrink-0" title="Toggle sidebar">{collapsedSidebar ? "Show List" : "Hide List"}</button>
          <button onClick={() => { setSelectedEndpoint(null); setTraceResult(null); setSelectedNode(null); }} className="text-xs px-3 py-1.5 rounded-md bg-[#1d1918] text-stone-300 border border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40 transition font-mono shrink-0">Reset</button>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden relative">
        <aside className={`shrink-0 border-r border-[#2a2222]/80 bg-[#121110]/95 flex flex-col overflow-hidden transition-all duration-300 ease-in-out backdrop-blur-md ${collapsedSidebar ? "w-0 opacity-0 pointer-events-none" : "w-[340px] opacity-100"}`}>
          <div className="p-4 border-b border-[#2a2222]">
            <label className="text-[10px] font-mono text-stone-500 uppercase tracking-wider">Search Endpoints</label>
            <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Filter by method, path, or handler..." className="w-full mt-2 px-3 py-2 bg-[#1a1716] border border-[#2e2a27] rounded-md text-xs font-mono text-stone-200 placeholder:text-stone-600 focus:outline-none focus:border-[#ff5330]/50 transition" />
          </div>
          <div className="p-3 space-y-2 flex-1 overflow-y-auto">
            {loadingEndpoints ? (<div className="text-xs text-stone-500 font-mono">Loading endpoints...</div>) : filteredEndpoints.length === 0 ? (<div className="text-xs text-stone-600 font-mono">No endpoints discovered.</div>) : (
              filteredEndpoints.map((ep) => (
                <button key={`${ep.method}-${ep.path}`} onClick={() => handleTrace(ep)} className={`w-full text-left px-3 py-2.5 rounded-lg border transition text-xs font-mono ${selectedEndpoint?.path === ep.path && selectedEndpoint?.method === ep.method ? "bg-[#ff5330]/20 border-[#ff5330]/50 text-[#ff8c6b]" : "bg-[#181514] border-[#2b2523] hover:border-[#ff5330]/30 hover:bg-[#1f1c1a] text-stone-300"}`}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded" style={{ backgroundColor: METHOD_COLORS[ep.method] ? METHOD_COLORS[ep.method] + "20" : "#2e2a27", color: METHOD_COLORS[ep.method] || "#8a7975" }}>{ep.method}</span>
                    <span className="text-[9px] text-stone-500 font-mono truncate">{ep.filePath}</span>
                  </div>
                  <div className="font-semibold truncate">{ep.path}</div>
                  {ep.handler && <div className="text-[10px] text-stone-500 truncate">→ {ep.handler}</div>}
                  <div className="text-[9px] text-stone-600 mt-0.5">{ep.confidence} confidence</div>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[#2a2222] p-3"><div className="text-[10px] text-stone-500 font-mono">Showing {filteredEndpoints.length} / {endpoints.length} discovered endpoints</div></div>
        </aside>

        <div className="flex-1 flex flex-col overflow-hidden bg-[#090808]">
          <div className="border-b border-[#2a2222] px-5 py-2.5 flex items-center justify-between bg-[#121110]/90 backdrop-blur-sm shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xs font-mono text-stone-400 truncate max-w-[320px]">
                {selectedEndpoint ? (<><span className="font-bold text-[#ff5330]">{selectedEndpoint.method}</span>{" "}<span className="text-stone-300">{selectedEndpoint.path}</span>{selectedEndpoint.handler ? (<span className="text-stone-500 ml-2">→ {selectedEndpoint.handler}</span>) : null}</>) : (<span className="text-stone-600">Select an endpoint to trace</span>)}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[9px] text-stone-600 font-mono uppercase tracking-wider">Static Analysis</span>
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden">
            <div className="absolute top-3 left-4 z-10 pointer-events-none select-none">
              <div className="text-[10px] font-mono text-stone-600 uppercase tracking-wider">Request flow</div>
              <div className="text-[9px] font-mono text-stone-700 leading-tight">Entry → Handler → Service → Data</div>
            </div>
            <div className="absolute top-3 right-4 z-10 bg-[#121110]/80 border border-[#2a2222]/60 rounded-lg px-3 py-2 backdrop-blur-md shadow-xl select-none">
              <div className="text-[9px] font-mono text-stone-500 uppercase tracking-widest mb-1">Legend</div>
              <div className="flex items-center gap-3 text-[9px] font-mono">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#1a2e3a] border border-[#3b82f6]"/> Endpoint</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#2a1f1c] border border-[#ff5330]"/> Controller</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#261635] border border-[#a855f7]"/> Service</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-[#1a2e1a] border border-[#4ade80]"/> Data</span>
              </div>
            </div>

            {loadingTrace ? (
              <div className="absolute inset-0 flex items-center justify-center"><div className="flex flex-col items-center gap-2"><div className="w-6 h-6 border-2 border-[#ff5330] border-t-transparent rounded-full animate-spin" /><span className="text-[10px] font-mono text-stone-500">Tracing static call paths...</span></div></div>
            ) : traceResult && traceResult.paths && traceResult.paths.length > 0 ? (
              <div className="w-full h-full flex items-center justify-center"><svg ref={svgRef} width="100%" height="100%" style={{ background: "#090808" }} /></div>
            ) : selectedEndpoint && !loadingTrace ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-stone-600">
                <div className="text-sm font-mono mb-2">No trace paths resolved</div>
                <p className="text-[11px] text-stone-500 max-w-md text-center px-8">The handler could not be statically linked to downstream calls. This can happen with dynamic dispatch, callbacks, or unresolved imports.</p>
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-stone-700 text-xs font-mono">Select an endpoint to start tracing</div>
            )}
          </div>

          <div className={`border-t border-[#2a2222] bg-[#121110] overflow-hidden transition-all duration-300 ease-in-out ${collapsedDetails ? "h-10" : "h-[220px]"}`}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-[#2a2222]/60">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#ff5330] font-mono">Trace Details</h3>
              <button onClick={() => setCollapsedDetails(!collapsedDetails)} className="text-[9px] px-2 py-0.5 rounded bg-[#1d1918] text-stone-400 border border-[#2e2a27] hover:text-white hover:border-[#ff5330]/40 transition font-mono" title="Toggle details">{collapsedDetails ? "Show" : "Hide"}</button>
            </div>
            <div className={`overflow-y-auto p-4 ${collapsedDetails ? "hidden" : "block"}`}>
              {selectedNode ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-stone-200 font-mono truncate">{selectedNode.name || selectedNode.label}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#2e2a27] text-stone-400 font-mono">{selectedNode.type}</span>
                    {selectedNode.confidence && (<span className="text-[9px] text-stone-500 font-mono">confidence: {selectedNode.confidence}</span>)}
                  </div>
                  <div className="text-[10px] text-stone-400 font-mono">File: {selectedNode.filePath}</div>
                  {selectedNode.line ? (<div className="text-[10px] text-stone-400 font-mono">Line: {selectedNode.line}</div>) : null}
                  <div className="text-[10px] text-stone-500 font-mono">Framework: {selectedNode.framework || "unknown"}</div>
                  <button onClick={() => { if (selectedNode.filePath) onInspectFile(selectedNode.filePath); }} className="mt-2 text-xs px-3 py-1.5 rounded-md bg-[#1e1a19] border border-[#332c29] text-stone-300 hover:text-white hover:border-[#ff5330]/40 transition font-mono">Inspect Source</button>
                </div>
              ) : selectedEndpoint ? (
                <div className="text-xs text-stone-500 font-mono">Select a node in the trace graph to inspect details.</div>
              ) : (
                <div className="text-xs text-stone-600 font-mono">No endpoint selected.</div>
              )}
              {traceResult && traceResult.paths && traceResult.paths.length > 0 && (
                <div className="mt-4 pt-3 border-t border-[#1f1d1b]">
                  <div className="text-[10px] font-bold text-stone-400 mb-1 font-mono">Resolved Paths ({traceResult.paths.length})</div>
                  <div className="space-y-1">
                    {traceResult.paths.slice(0, 5).map((p: any, i: number) => (
                      <div key={i} className="text-[10px] text-stone-500 font-mono truncate">
                        {i + 1}.{" "}
                        {p.steps.map((s: any) => s.name || s.label).join(" -> ")}
                        {p.note ? ` (${p.note})` : ""}
                      </div>
                    ))}
                  </div>
                  {traceResult.partial && (<div className="mt-2 text-[10px] text-amber-500 font-mono">Partial resolution — flows may continue beyond static inference.</div>)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
