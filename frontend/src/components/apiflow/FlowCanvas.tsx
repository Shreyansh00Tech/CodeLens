import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { FlowLayout, LaidOutEdge, LaidOutNode } from "../../lib/flowLayout";
import { NODE_H, NODE_W } from "../../lib/flowLayout";
import { KIND_META, edgeColor, shortFile, statusColor } from "./flowTheme";

export type FlowCanvasHandle = {
  fit: (animate?: boolean) => void;
  zoomBy: (k: number) => void;
  focusNode: (id: string) => void;
};

type Props = {
  layout: FlowLayout;
  selectedId: string | null;
  highlight: Set<string> | null;
  onSelect: (id: string | null) => void;
  selectedEdgeId?: string | null;
  onSelectEdge?: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onToggleCollapse: (id: string) => void;
  onOpenSource: (id: string) => void;
  collapsed: Set<string>;
};

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

const FlowCanvas = forwardRef<FlowCanvasHandle, Props>(function FlowCanvas(
  { layout, selectedId, highlight, onSelect, onHover, onToggleCollapse, onOpenSource, collapsed, selectedEdgeId = null, onSelectEdge },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef<SVGGElement | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [transform, setTransform] = useState<d3.ZoomTransform>(d3.zoomIdentity);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const rafRef = useRef<number | null>(null);

  // Track container size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zoom behaviour (transform applied directly to the <g>; React state only feeds the minimap)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .filter((ev: Event) => {
        const e = ev as MouseEvent & WheelEvent;
        if (e.type === "dblclick") return false;
        return (!e.ctrlKey || e.type === "wheel") && !e.button;
      })
      .on("zoom", (ev: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        viewRef.current?.setAttribute("transform", ev.transform.toString());
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            setTransform(ev.transform);
          });
        }
      });
    zoomRef.current = zoom;
    const sel = d3.select(svg);
    sel.call(zoom).on("dblclick.zoom", null);
    return () => {
      sel.on(".zoom", null);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  const fitTransform = useCallback(() => {
    const { bounds } = layout;
    const pad = 56;
    const k = Math.max(MIN_ZOOM, Math.min(1.1, Math.min((size.w - pad * 2) / bounds.w, (size.h - pad * 2) / bounds.h)));
    const tx = size.w / 2 - (bounds.x + bounds.w / 2) * k;
    const ty = size.h / 2 - (bounds.y + bounds.h / 2) * k;
    return d3.zoomIdentity.translate(tx, ty).scale(k);
  }, [layout, size]);

  /** First view of a new graph: fit if readable, otherwise a readable zoom anchored at the entry. */
  const initialTransform = useCallback(() => {
    const fit = fitTransform();
    const READABLE = 0.72;
    if (fit.k >= READABLE) return fit;
    const { bounds } = layout;
    const k = READABLE;
    const tx = 40 - bounds.x * k;
    const contentH = bounds.h * k;
    const ty = contentH <= size.h - 80 ? size.h / 2 - (bounds.y + bounds.h / 2) * k : 110 - bounds.y * k;
    return d3.zoomIdentity.translate(tx, ty).scale(k);
  }, [fitTransform, layout, size]);

  const apply = useCallback((t: d3.ZoomTransform, animate = true) => {
    const svg = svgRef.current;
    const zoom = zoomRef.current;
    if (!svg || !zoom) return;
    const sel = d3.select(svg);
    if (animate) sel.transition().duration(420).ease(d3.easeCubicOut).call(zoom.transform, t);
    else sel.call(zoom.transform, t);
  }, []);

  useImperativeHandle(ref, () => ({
    fit: (animate = true) => apply(fitTransform(), animate),
    zoomBy: (k: number) => {
      const svg = svgRef.current;
      const zoom = zoomRef.current;
      if (svg && zoom) d3.select(svg).transition().duration(200).call(zoom.scaleBy, k);
    },
    focusNode: (id: string) => {
      const n = layout.byId.get(id);
      if (!n) return;
      const svg = svgRef.current;
      if (!svg) return;
      const cur = d3.zoomTransform(svg);
      const k = Math.max(cur.k, 0.8);
      apply(d3.zoomIdentity.translate(size.w / 2 - (n.x + NODE_W / 2) * k, size.h / 2 - (n.y + NODE_H / 2) * k).scale(k));
    },
  }), [apply, fitTransform, layout, size]);

  // Fit when a new graph arrives (by entry) or the container size first settles
  const layoutKey = layout.nodes.length ? layout.nodes[0].id + ":" + layout.nodes.length : "";
  const fittedKey = useRef<string>("");
  useEffect(() => {
    const key = `${layoutKey}|${Math.round(size.w / 50)}x${Math.round(size.h / 50)}`;
    if (!layoutKey || fittedKey.current === key) return;
    const first = !fittedKey.current.startsWith(layoutKey);
    fittedKey.current = key;
    apply(first ? initialTransform() : fitTransform(), !first);
  }, [layoutKey, size, apply, fitTransform, initialTransform]);

  const edgesEl = useMemo(
    () => layout.edges.map((e) => (
      <FlowEdgePath
        key={e.id}
        edge={e}
        dim={!!highlight && !(highlight.has(e.from) && highlight.has(e.to)) && e.id !== selectedEdgeId}
        active={e.id === selectedEdgeId || (!selectedEdgeId && !!selectedId && (e.from === selectedId || e.to === selectedId))}
        selected={e.id === selectedEdgeId}
        onSelect={onSelectEdge}
      />
    )),
    [layout.edges, highlight, selectedId, selectedEdgeId, onSelectEdge],
  );
  const nodesEl = useMemo(
    () =>
      layout.nodes.map((n) => (
        <FlowNodeCard
          key={n.id}
          node={n}
          selected={n.id === selectedId}
          dim={!!highlight && !highlight.has(n.id)}
          collapsed={collapsed.has(n.id)}
          onSelect={onSelect}
          onHover={onHover}
          onToggleCollapse={onToggleCollapse}
          onOpenSource={onOpenSource}
        />
      )),
    [layout.nodes, selectedId, highlight, collapsed, onSelect, onHover, onToggleCollapse, onOpenSource],
  );

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        className="block cursor-grab active:cursor-grabbing select-none"
        role="img"
        aria-label="API request flow graph"
        onClick={(e) => { if (e.target === svgRef.current) onSelect(null); }}
      >
        <defs>
          <pattern id="cl-flow-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="#2a2421" />
          </pattern>
          {["#5b4a44", "#ff8c6b", "#4ade80", "#22d3ee", "#ef4444", "#f5b347", "#a855f7", "#60a5fa"].map((c) => (
            <marker key={c} id={`cl-arrow-${c.slice(1)}`} viewBox="0 -5 10 10" refX="9" refY="0" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,-4.5L9,0L0,4.5Z" fill={c} />
            </marker>
          ))}
        </defs>
        <rect width="100%" height="100%" fill="url(#cl-flow-grid)" onClick={() => onSelect(null)} />
        <g ref={viewRef}>
          <g>{edgesEl}</g>
          <g>{nodesEl}</g>
        </g>
      </svg>
      <Minimap layout={layout} transform={transform} size={size} highlight={highlight} selectedId={selectedId} onPan={(x, y) => {
        const svg = svgRef.current;
        if (!svg) return;
        const k = d3.zoomTransform(svg).k;
        apply(d3.zoomIdentity.translate(size.w / 2 - x * k, size.h / 2 - y * k).scale(k), false);
      }} />
    </div>
  );
});

export default FlowCanvas;

// ------------------------------------------------------------------ edges

const FlowEdgePath = memo(function FlowEdgePath({ edge, dim, active, selected, onSelect }: { edge: LaidOutEdge; dim: boolean; active: boolean; selected: boolean; onSelect?: (id: string | null) => void }) {
  const color = active ? "#ff8c6b" : edge.back ? "#a855f7" : edgeColor(edge.kind);
  const markerColor = active ? "ff8c6b" : edge.back ? "a855f7" : edgeColor(edge.kind).slice(1);
  return (
    <g className="transition-opacity duration-200" opacity={dim ? 0.12 : 1}>
      <path
        d={edge.d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        style={{ cursor: onSelect ? "pointer" : undefined, pointerEvents: "stroke" }}
        onClick={(ev) => { ev.stopPropagation(); onSelect?.(edge.id); }}
        data-edge-id={edge.id}
      >
        <title>{`${edgeTitle(edge)} · click to see why`}</title>
      </path>
      {selected && <path d={edge.d} fill="none" stroke="#ff5330" strokeOpacity={0.25} strokeWidth={7} pointerEvents="none" />}
      <path
        d={edge.d}
        fill="none"
        stroke={color}
        strokeWidth={active ? 2.2 : 1.4}
        strokeOpacity={active ? 1 : 0.75}
        strokeDasharray={edge.conditional ? "5 4" : edge.kind === "error" ? "2 3" : undefined}
        markerEnd={`url(#cl-arrow-${markerColor})`}
        className={active ? "cl-flow-dash" : undefined}
        pointerEvents="none"
      />
      {(edge.count > 1 || edge.back) && (
        <g transform={`translate(${edge.mid.x},${edge.mid.y})`} pointerEvents="none">
          <rect x={-14} y={-8} width={28} height={16} rx={8} fill="#121110" stroke={color} strokeOpacity={0.5} />
          <text textAnchor="middle" dy={3.5} fontSize={9} fill={color} fontFamily="JetBrains Mono, ui-monospace, monospace">{edge.back ? "↺" : `×${edge.count}`}</text>
        </g>
      )}
    </g>
  );
});

function edgeTitle(e: LaidOutEdge) {
  const verb: Record<string, string> = { next: "passes control to", handles: "hands the request to", calls: "calls", queries: "queries", external: "calls external", responds: "sends response", error: "forwards error to" };
  const parts = [verb[e.kind] || e.kind];
  if (e.lines.length) parts.push(`at line ${e.lines.join(", ")}`);
  if (e.conditional) parts.push("(conditional)");
  if (e.back) parts.push("(recursive / cycle)");
  return parts.join(" ");
}

// ------------------------------------------------------------------ nodes

type CardProps = {
  node: LaidOutNode;
  selected: boolean;
  dim: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onToggleCollapse: (id: string) => void;
  onOpenSource: (id: string) => void;
};

const FlowNodeCard = memo(function FlowNodeCard({ node, selected, dim, collapsed, onSelect, onHover, onToggleCollapse, onOpenSource }: CardProps) {
  const meta = KIND_META[node.kind] || KIND_META.function;
  const accent = node.kind === "response" ? statusColor(node.status) : meta.color;
  const unresolved = node.resolution === "unresolved";
  const subtitle = node.members
    ? node.detail || ""
    : node.kind === "response"
      ? `${shortFile(node.filePath)}:${node.line}${node.statusImplicit ? " · implicit status" : ""}`
      : node.kind === "external" || (node.kind === "middleware" && node.package)
        ? node.package || node.category || ""
        : node.filePath
          ? `${shortFile(node.filePath)}${node.line ? `:${node.line}` : ""}`
          : "";
  const unresolvedCount = node.unresolved?.length || 0;
  const label = node.kind === "endpoint" ? node.path || node.name : node.name;

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      className="cl-flow-node transition-opacity duration-200"
      opacity={dim ? 0.22 : 1}
      style={{ cursor: "pointer" }}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); onOpenSource(node.id); }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      data-node-id={node.id}
    >
      {node.members && (
        <>
          <rect x={8} y={-8} width={NODE_W - 16} height={NODE_H} rx={10} fill="#15110d" stroke={accent} strokeOpacity={0.25} />
          <rect x={4} y={-4} width={NODE_W - 8} height={NODE_H} rx={10} fill="#18130e" stroke={accent} strokeOpacity={0.35} />
        </>
      )}
      {selected && <rect x={-4} y={-4} width={NODE_W + 8} height={NODE_H + 8} rx={13} fill="none" stroke="#ff8c6b" strokeOpacity={0.35} strokeWidth={6} />}
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={selected ? "#1f1816" : meta.bg}
        stroke={selected ? "#ff8c6b" : accent}
        strokeOpacity={selected ? 1 : unresolved ? 0.5 : 0.55}
        strokeWidth={selected ? 1.8 : 1.1}
        strokeDasharray={unresolved ? "4 3" : undefined}
      />
      <rect x={0} y={0} width={4} height={NODE_H} rx={2} fill={accent} />
      {/* kind pill */}
      <text x={14} y={17} fontSize={8.5} letterSpacing="0.12em" fill={accent} fontFamily="JetBrains Mono, ui-monospace, monospace" fontWeight={700}>
        {node.kind === "endpoint" ? (node.method || "").toUpperCase() : node.kind === "response" ? "RESPONSE" : node.members ? "MIDDLEWARE GROUP" : meta.label.toUpperCase()}
        {node.async ? <tspan fill="#8a7975" fontWeight={500}>{"  ASYNC"}</tspan> : null}
      </text>
      <text x={14} y={35} fontSize={12} fill={selected ? "#fff" : "#ece6df"} fontFamily="JetBrains Mono, ui-monospace, monospace" fontWeight={600}>
        {truncate(label, 25)}
        <title>{label}</title>
      </text>
      <text x={14} y={49} fontSize={9.5} fill="#8a7975" fontFamily="JetBrains Mono, ui-monospace, monospace">
        {truncate(subtitle, 32)}
      </text>
      {node.members && <title>{`${node.detail}\nDouble-click to expand`}</title>}
      {/* badges on the right */}
      {node.resolution === "pattern" && (
        <g transform={`translate(${NODE_W - 12},14)`}>
          <circle r={4} fill="none" stroke="#a79a90" strokeDasharray="1.5 1.5" />
          <title>Detected by a naming / API pattern rather than a resolved definition</title>
        </g>
      )}
      {unresolvedCount > 0 && (
        <g transform={`translate(${NODE_W - 30},6)`}>
          <rect width={24} height={14} rx={7} fill="#3a2a12" stroke="#f5b347" strokeOpacity={0.6} />
          <text x={12} y={10} textAnchor="middle" fontSize={8.5} fill="#f5b347" fontFamily="JetBrains Mono, ui-monospace, monospace">?{unresolvedCount}</text>
          <title>{unresolvedCount} call(s) inside could not be resolved statically</title>
        </g>
      )}
      {node.truncated && (
        <text x={NODE_W - 10} y={50} textAnchor="end" fontSize={9} fill="#f5b347" fontFamily="JetBrains Mono, ui-monospace, monospace">…<title>Depth limit reached: deeper calls not traced</title></text>
      )}
      {(node.hiddenChildren > 0 || collapsed) && (
        <g transform={`translate(${NODE_W + 4},${NODE_H / 2 - 9})`} onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id); }}>
          <rect width={30} height={18} rx={9} fill="#2b1f1c" stroke="#ff5330" strokeOpacity={0.6} />
          <text x={15} y={12.5} textAnchor="middle" fontSize={9} fill="#ff8c6b" fontFamily="JetBrains Mono, ui-monospace, monospace">+{node.hiddenChildren}</text>
          <title>Expand {node.hiddenChildren} hidden step(s)</title>
        </g>
      )}
    </g>
  );
});

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ------------------------------------------------------------------ minimap

function Minimap({ layout, transform, size, highlight, selectedId, onPan }: {
  layout: FlowLayout; transform: d3.ZoomTransform; size: { w: number; h: number }; highlight: Set<string> | null; selectedId: string | null; onPan: (x: number, y: number) => void;
}) {
  const W = 168;
  const H = 104;
  const { bounds } = layout;
  if (layout.nodes.length < 6) return null;
  const s = Math.min(W / bounds.w, H / bounds.h);
  const ox = (W - bounds.w * s) / 2 - bounds.x * s;
  const oy = (H - bounds.h * s) / 2 - bounds.y * s;
  // viewport in graph coordinates
  const vx = -transform.x / transform.k;
  const vy = -transform.y / transform.k;
  const vw = size.w / transform.k;
  const vh = size.h / transform.k;
  const pan = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPan((e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s);
  };
  return (
    <div className="absolute bottom-3 right-3 z-10 rounded-lg border border-[#2a2222] bg-[#121110]/90 backdrop-blur-md shadow-xl p-1.5 hidden sm:block">
      <svg
        width={W}
        height={H}
        className="block cursor-crosshair"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pan(e); }}
        onPointerMove={(e) => { if (e.buttons === 1) pan(e); }}
        aria-label="Minimap"
      >
        {layout.nodes.map((n) => {
          const meta = KIND_META[n.kind] || KIND_META.function;
          return (
            <rect key={n.id} x={ox + n.x * s} y={oy + n.y * s} width={Math.max(2, NODE_W * s)} height={Math.max(1.5, NODE_H * s)} rx={1}
              fill={n.id === selectedId ? "#ff8c6b" : n.kind === "response" ? statusColor(n.status) : meta.color}
              opacity={highlight && !highlight.has(n.id) ? 0.2 : 0.8} />
          );
        })}
        <rect x={ox + vx * s} y={oy + vy * s} width={vw * s} height={vh * s} fill="rgba(255,83,48,0.07)" stroke="#ff5330" strokeWidth={1} rx={2} />
      </svg>
    </div>
  );
}
