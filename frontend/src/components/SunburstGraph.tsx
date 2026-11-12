import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import * as d3 from "d3";
import type { GraphData, GraphHandle, Highlight } from "../lib/types";
import { buildAdjacency, computeLayers, fileName, folderOf, linkKey } from "../lib/graphAnalysis";

/**
 * Circular sunburst of dependency layers. Core modules (that import nothing
 * internal) sit in the centre; every ring outward depends on the rings inside
 * it; isolated files form the outermost ring. Files are grouped by folder
 * around the circle, and dependency edges are drawn as curves through the
 * centre.
 */

type Props = {
  data: GraphData | null;
  selectedFile?: string | null;
  highlight?: Highlight | null;
  search?: string;
  onNodeClick?: (id: string) => void;
  onNodeContextMenu?: (id: string, clientX: number, clientY: number) => void;
  onBackgroundClick?: () => void;
  /** Inactive views stay mounted (to keep layout) but stop animating. */
  active?: boolean;
};

type Seg = {
  id: string;
  ring: number;
  a0: number;
  a1: number;
  folder: string;
  color: string;
};

const BG = "#0c0a09";
const INNER = 70;
const RING_GAP = 4;
const DEPTH_STEP_MS = 160;

const FOLDER_PALETTE = ["#ff5330", "#ff8a4c", "#ffb547", "#ffd9bc", "#e8735a", "#c9a28f", "#ff6f61", "#f4a582", "#d96b43", "#ffcf99"];

const SunburstGraph = forwardRef<GraphHandle, Props>(function SunburstGraph(
  { data, selectedFile = null, highlight = null, search = "", onNodeClick, onNodeContextMenu, onBackgroundClick, active = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });
  const hoverRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const introStartRef = useRef(0);
  const highlightStartRef = useRef(0);

  const propsRef = useRef({ selectedFile, highlight, search, onNodeClick, onNodeContextMenu, onBackgroundClick, active });
  useLayoutEffect(() => {
    propsRef.current = { selectedFile, highlight, search, onNodeClick, onNodeContextMenu, onBackgroundClick, active };
  });

  // ------------------------------------------------------------- layout
  const layout = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    const adj = buildAdjacency(data);
    const { layer, isolated, maxLayer } = computeLayers(data, adj);
    const MAX_RINGS = 7;
    const ringCount = Math.min(maxLayer + 1, MAX_RINGS);
    const ringOf = (l: number) => Math.min(l, ringCount - 1);

    const rings: string[][] = Array.from({ length: ringCount + (isolated.length ? 1 : 0) }, () => []);
    for (const [id, l] of layer) rings[ringOf(l)].push(id);
    if (isolated.length) rings[rings.length - 1].push(...isolated);

    const folders = [...new Set(data.nodes.map((n) => folderOf(n.id)))].sort();
    const folderColor = new Map(folders.map((f, i) => [f, FOLDER_PALETTE[i % FOLDER_PALETTE.length]]));

    const segs = new Map<string, Seg>();
    rings.forEach((ids, ring) => {
      ids.sort((a, b) => folderOf(a).localeCompare(folderOf(b)) || a.localeCompare(b));
      const n = ids.length || 1;
      const step = (Math.PI * 2) / n;
      ids.forEach((id, i) => {
        const f = folderOf(id);
        segs.set(id, { id, ring, a0: i * step, a1: (i + 1) * step, folder: f, color: folderColor.get(f)! });
      });
    });

    const ringLabels = rings.map((_, i) => {
      if (isolated.length && i === rings.length - 1) return "Isolated";
      if (i === 0) return "Core";
      if (i === ringCount - 1 && ringCount > 1) return i === MAX_RINGS - 1 && maxLayer >= MAX_RINGS ? `L${i}+ · Entry` : `L${i} · Entry`;
      return `L${i}`;
    });

    return { segs, rings, ringLabels, folders, folderColor, links: data.links };
  }, [data]);

  const geometry = useCallback(
    (w: number, h: number) => {
      const rings = layout?.rings.length || 1;
      const outer = Math.max(INNER + rings * 30, Math.min(w, h) / 2 - 56);
      const thick = (outer - INNER) / rings;
      return { cx: w / 2, cy: h / 2, thick, outer };
    },
    [layout]
  );

  // ------------------------------------------------------------- drawing
  const drawScene = useCallback(
    (ctx: CanvasRenderingContext2D, t: d3.ZoomTransform, w: number, h: number, now: number, exporting = false) => {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      if (!layout) return;
      const live = propsRef.current;
      // Exports show the neutral, whole-architecture view.
      const sel = exporting ? null : live.selectedFile;
      const hl = exporting ? null : live.highlight;
      const q = exporting ? "" : live.search;
      const hover = exporting ? null : hoverRef.current;
      const { cx, cy, thick, outer } = geometry(w, h);
      const intro = exporting ? 1 : d3.easeCubicOut(Math.min(1, (now - introStartRef.current) / 700));
      const elapsed = now - highlightStartRef.current;
      const query = q.trim().toLowerCase();
      const focus = hover || sel;
      const revealed = (id: string) => {
        if (!hl) return true;
        const d = hl.depth.get(id);
        return d !== undefined && (exporting || d * DEPTH_STEP_MS <= elapsed);
      };

      const connected = new Set<string>();
      if (focus) {
        for (const l of layout.links) {
          if (l.source === focus) connected.add(l.target);
          if (l.target === focus) connected.add(l.source);
        }
      }

      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 2);

      // Ring guides
      for (let r = 0; r <= layout.rings.length; r++) {
        ctx.beginPath();
        ctx.arc(0, 0, INNER + r * thick * intro, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1 / t.k;
        ctx.stroke();
      }

      const midR = (s: Seg) => INNER + (s.ring + 0.5) * thick;
      const point = (s: Seg) => {
        const a = (s.a0 + s.a1) / 2;
        const r = INNER + s.ring * thick + RING_GAP / 2;
        return [r * Math.cos(a), r * Math.sin(a)];
      };

      // Dependency curves through the centre
      const dimPath = new Path2D();
      const strongPath = new Path2D();
      let strongCount = 0;
      for (const l of layout.links) {
        const s = layout.segs.get(l.source);
        const tg = layout.segs.get(l.target);
        if (!s || !tg) continue;
        const [x1, y1] = point(s);
        const [x2, y2] = point(tg);
        const emph = hl
          ? hl.links.has(linkKey(l.source, l.target)) && revealed(l.source) && revealed(l.target)
          : focus
            ? l.source === focus || l.target === focus
            : false;
        const p = emph ? strongPath : dimPath;
        p.moveTo(x1, y1);
        p.quadraticCurveTo((x1 + x2) * 0.15, (y1 + y2) * 0.15, x2, y2);
        if (emph) strongCount++;
      }
      ctx.lineWidth = 1 / t.k;
      ctx.strokeStyle = hl || focus ? "rgba(255,255,255,0.03)" : "rgba(255,90,54,0.13)";
      ctx.globalAlpha = intro;
      ctx.stroke(dimPath);
      if (strongCount) {
        ctx.lineWidth = 1.8 / t.k;
        ctx.strokeStyle = hl?.kind === "cycle" ? "rgba(255,59,48,0.85)" : "rgba(255,138,107,0.8)";
        ctx.setLineDash([5, 7]);
        ctx.lineDashOffset = exporting ? 0 : -(now / 40) % 12;
        ctx.stroke(strongPath);
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;

      // Segments
      const labels: { s: Seg; strong: boolean }[] = [];
      for (const s of layout.segs.values()) {
        let fill = s.color;
        let alpha = 0.78;
        let stroke: string | null = null;
        if (hl) {
          const d = hl.depth.get(s.id);
          if (d === undefined || !revealed(s.id)) alpha = 0.08;
          else {
            alpha = 1;
            fill = s.id === hl.source ? "#ffffff" : hl.kind === "cycle" ? "#ff3b30" : d === 1 ? "#ff5330" : d === 2 ? "#ff8a4c" : "#ffb547";
          }
        } else if (focus) {
          if (s.id === focus) {
            fill = "#ffffff";
            alpha = 1;
          } else if (connected.has(s.id)) alpha = 1;
          else alpha = 0.14;
        }
        if (query && s.id.toLowerCase().includes(query)) {
          stroke = "#ffd9bc";
          alpha = Math.max(alpha, 0.95);
        }
        const r0 = INNER + s.ring * thick * intro + RING_GAP / 2;
        const r1 = INNER + (s.ring + 1) * thick * intro - RING_GAP / 2;
        const pad = Math.min(0.012, (s.a1 - s.a0) * 0.12);
        ctx.beginPath();
        ctx.arc(0, 0, r1, s.a0 + pad, s.a1 - pad);
        ctx.arc(0, 0, r0, s.a1 - pad, s.a0 + pad, true);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.5 / t.k;
          ctx.stroke();
        }
        const arcLen = (s.a1 - s.a0) * midR(s) * t.k;
        if (alpha > 0.5 && (arcLen > 13 || s.id === focus || s.id === hl?.source)) labels.push({ s, strong: s.id === focus || s.id === hl?.source });
      }
      ctx.globalAlpha = 1;

      // Segment labels (radial)
      if (intro > 0.95) {
        const fontPx = Math.max(7, Math.min(11, thick * 0.32)) / Math.sqrt(t.k);
        ctx.font = `${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.textBaseline = "middle";
        for (const { s, strong } of labels.slice(0, 500)) {
          const a = (s.a0 + s.a1) / 2;
          const r = INNER + s.ring * thick + 6;
          ctx.save();
          ctx.rotate(a);
          const flip = Math.cos(a - Math.PI / 2) < 0; // keep text upright after the -90deg rotation
          ctx.translate(r, 0);
          if (flip) {
            ctx.rotate(Math.PI);
            ctx.textAlign = "right";
            ctx.translate(-0, 0);
          } else ctx.textAlign = "left";
          let label = fileName(s.id);
          const maxChars = Math.max(4, Math.floor((thick - 10) / (fontPx * 0.62)));
          if (label.length > maxChars) label = label.slice(0, maxChars - 1) + "…";
          ctx.fillStyle = strong ? "#0c0a09" : "rgba(12,10,9,0.86)";
          ctx.fillText(label, flip ? -0 : 0, 0);
          ctx.restore();
        }
      }

      ctx.restore();

      // Ring legend along the top
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);
      ctx.font = `600 ${10 / Math.sqrt(t.k)}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textAlign = "left";
      layout.ringLabels.forEach((label, i) => {
        const r = INNER + (i + 0.5) * thick * intro;
        ctx.fillStyle = "rgba(167,154,144,0.75)";
        ctx.fillText(label, cx + 4, cy - r);
      });
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,83,48,0.9)";
      ctx.font = `700 ${11 / Math.sqrt(t.k)}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillText("CORE", cx, cy - 4);
      ctx.fillStyle = "rgba(167,154,144,0.6)";
      ctx.font = `${9 / Math.sqrt(t.k)}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.fillText(`${layout.segs.size} files`, cx, cy + 10);
      ctx.restore();
      void outer;
    },
    [layout, geometry]
  );

  const renderRef = useRef<() => void>(() => {});
  const render = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { w, h, dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    drawScene(ctx, transformRef.current, w, h, now);
    const p = propsRef.current;
    if (p.active && (now - introStartRef.current < 750 || p.highlight || hoverRef.current || p.selectedFile)) {
      frameRef.current = requestAnimationFrame(() => renderRef.current());
    }
  }, [drawScene]);

  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  const requestDraw = useCallback(() => {
    if (frameRef.current == null) frameRef.current = requestAnimationFrame(() => renderRef.current());
  }, []);

  const segAt = useCallback(
    (clientX: number, clientY: number): Seg | null => {
      const canvas = canvasRef.current;
      if (!canvas || !layout) return null;
      const rect = canvas.getBoundingClientRect();
      const [x, y] = transformRef.current.invert([clientX - rect.left, clientY - rect.top]);
      const { cx, cy, thick } = geometry(sizeRef.current.w, sizeRef.current.h);
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const ring = Math.floor((r - INNER) / thick);
      if (ring < 0 || ring >= layout.rings.length) return null;
      let a = Math.atan2(dy, dx) + Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      const ids = layout.rings[ring];
      if (!ids.length) return null;
      const i = Math.min(ids.length - 1, Math.floor((a / (Math.PI * 2)) * ids.length));
      return layout.segs.get(ids[i]) || null;
    },
    [layout, geometry]
  );

  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !zoomRef.current) return;
    d3.select(canvas).transition().duration(500).call(zoomRef.current.transform, d3.zoomIdentity);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomToFit,
      snapshot: (scale = 2) => {
        if (!layout) return null;
        const w = 1400;
        const h = 1400;
        const off = document.createElement("canvas");
        off.width = w * scale;
        off.height = h * scale;
        const ctx = off.getContext("2d");
        if (!ctx) return null;
        ctx.scale(scale, scale);
        drawScene(ctx, d3.zoomIdentity, w, h, performance.now(), true);
        return off.toDataURL("image/png");
      },
    }),
    [drawScene, layout, zoomToFit]
  );

  useEffect(() => {
    const canvas = canvasRef.current!;
    const container = containerRef.current!;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    const zoom = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.4, 10])
      .filter((event) => !event.button)
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        requestDraw();
      });
    zoomRef.current = zoom;
    const sel = d3.select(canvas);
    sel.call(zoom).on("dblclick.zoom", null);

    const onMove = (e: MouseEvent) => {
      const s = segAt(e.clientX, e.clientY);
      const id = s?.id ?? null;
      const tip = tooltipRef.current;
      if (tip) {
        if (s && layout) {
          const rect = container.getBoundingClientRect();
          tip.style.display = "block";
          tip.style.transform = `translate(${e.clientX - rect.left + 14}px, ${e.clientY - rect.top + 14}px)`;
          if (hoverRef.current !== id) {
            tip.innerHTML = "";
            const title = document.createElement("div");
            title.className = "cl-tip-title";
            title.textContent = s.id;
            const meta = document.createElement("div");
            meta.className = "cl-tip-meta";
            meta.textContent = `${layout.ringLabels[s.ring]} · ${s.folder} · right-click for impact`;
            tip.append(title, meta);
          }
        } else tip.style.display = "none";
      }
      if (hoverRef.current !== id) {
        hoverRef.current = id;
        canvas.style.cursor = id ? "pointer" : "grab";
        requestDraw();
      }
    };
    const onLeave = () => {
      hoverRef.current = null;
      if (tooltipRef.current) tooltipRef.current.style.display = "none";
      requestDraw();
    };
    const onClick = (e: MouseEvent) => {
      const s = segAt(e.clientX, e.clientY);
      if (s) propsRef.current.onNodeClick?.(s.id);
      else propsRef.current.onBackgroundClick?.();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const s = segAt(e.clientX, e.clientY);
      if (s) propsRef.current.onNodeContextMenu?.(s.id, e.clientX, e.clientY);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      ro.disconnect();
      sel.on(".zoom", null);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("contextmenu", onContext);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [segAt, requestDraw, layout]);

  useEffect(() => {
    introStartRef.current = performance.now();
    requestDraw();
  }, [layout, requestDraw]);

  // Replay the intro animation each time the view is shown.
  useEffect(() => {
    if (active) {
      introStartRef.current = performance.now();
      requestDraw();
    }
  }, [active, requestDraw]);

  useEffect(() => {
    highlightStartRef.current = performance.now();
    requestDraw();
  }, [highlight, requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [selectedFile, search, active, requestDraw]);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden" style={{ background: BG }}>
      <canvas ref={canvasRef} className="block" style={{ cursor: "grab", touchAction: "none" }} />
      <div ref={tooltipRef} className="cl-tip" style={{ display: "none" }} />
      {layout && (
        <div className="absolute bottom-4 right-4 max-w-[260px] bg-[#121110]/80 border border-[#2e2a27] rounded-lg px-3 py-2 backdrop-blur-md pointer-events-none">
          <div className="text-[9px] font-mono uppercase tracking-widest text-stone-500 mb-1.5">Folders</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {layout.folders.slice(0, 10).map((f) => (
              <span key={f} className="flex items-center gap-1 text-[10px] font-mono text-stone-400 max-w-[120px] truncate">
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: layout.folderColor.get(f) }} />
                {f}
              </span>
            ))}
            {layout.folders.length > 10 && <span className="text-[10px] font-mono text-stone-600">+{layout.folders.length - 10} more</span>}
          </div>
        </div>
      )}
    </div>
  );
});

export default SunburstGraph;
