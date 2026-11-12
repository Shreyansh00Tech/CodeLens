import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import * as d3 from "d3";
import type { GraphData, GraphHandle, Highlight } from "../lib/types";
import { fileName, linkKey, nodeCategoryColor } from "../lib/graphAnalysis";

/**
 * Canvas-rendered force-directed dependency graph.
 *
 * Everything is drawn on a single <canvas> with batched paths, and frames are
 * only rendered while something is moving (simulation, animation, zoom or
 * hover), so it stays smooth on repositories with thousands of files.
 */

type SimNode = d3.SimulationNodeDatum & {
  id: string;
  r: number;
  color: string;
  lines: number;
  deg: number;
};
type SimLink = d3.SimulationLinkDatum<SimNode> & { source: SimNode; target: SimNode; key: string };

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

const BG = "#0c0a09";
const DEPTH_STEP_MS = 160;
const positionCache = new Map<string, { x: number; y: number }>();

const ForceGraph = forwardRef<GraphHandle, Props>(function ForceGraph(
  { data, selectedFile = null, highlight = null, search = "", onNodeClick, onNodeContextMenu, onBackgroundClick, active = true },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const neighborsRef = useRef<Map<string, Set<string>>>(new Map());
  const simRef = useRef<d3.Simulation<SimNode, SimLink> | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity);
  const sizeRef = useRef({ w: 800, h: 600, dpr: 1 });
  const hoverRef = useRef<string | null>(null);
  const frameRef = useRef<number | null>(null);
  const highlightStartRef = useRef(0);
  const fittedRef = useRef(false);

  // Latest props for the render loop without re-subscribing listeners.
  const propsRef = useRef({ selectedFile, highlight, search, onNodeClick, onNodeContextMenu, onBackgroundClick, active });
  useLayoutEffect(() => {
    propsRef.current = { selectedFile, highlight, search, onNodeClick, onNodeContextMenu, onBackgroundClick, active };
  });

  // ---------------------------------------------------------------- drawing
  const drawScene = useCallback(
    (ctx: CanvasRenderingContext2D, t: d3.ZoomTransform, w: number, h: number, now: number, exporting = false) => {
      const live = propsRef.current;
      // Exports show the neutral, whole-architecture view.
      const sel = exporting ? null : live.selectedFile;
      const hl = exporting ? null : live.highlight;
      const q = exporting ? "" : live.search;
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const hover = exporting ? null : hoverRef.current;
      const neighbors = neighborsRef.current;
      const elapsed = now - highlightStartRef.current;
      const query = q.trim().toLowerCase();

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.scale(t.k, t.k);

      const focusId = hover || sel;
      const focusSet = focusId ? neighbors.get(focusId) : null;
      const revealed = (id: string) => {
        if (!hl) return true;
        const d = hl.depth.get(id);
        return d !== undefined && (exporting || d * DEPTH_STEP_MS <= elapsed);
      };

      // ---- links, batched by style
      const dim: SimLink[] = [];
      const normal: SimLink[] = [];
      const strong: SimLink[] = [];
      for (const l of links) {
        if (hl) {
          if (hl.links.has(l.key) && revealed(l.source.id) && revealed(l.target.id)) strong.push(l);
          else dim.push(l);
        } else if (focusId) {
          if (l.source.id === focusId || l.target.id === focusId) strong.push(l);
          else dim.push(l);
        } else normal.push(l);
      }
      const stroke = (batch: SimLink[], style: string, width: number) => {
        if (!batch.length) return;
        ctx.beginPath();
        for (const l of batch) {
          ctx.moveTo(l.source.x!, l.source.y!);
          ctx.lineTo(l.target.x!, l.target.y!);
        }
        ctx.strokeStyle = style;
        ctx.lineWidth = width / Math.sqrt(t.k);
        ctx.stroke();
      };
      stroke(dim, "rgba(255,255,255,0.035)", 1);
      stroke(normal, "rgba(255,90,54,0.22)", 1);
      if (strong.length) {
        stroke(strong, hl ? "rgba(255,83,48,0.35)" : "rgba(255,138,107,0.55)", 2.2);
        // Animated flow along emphasised edges (importer -> imported).
        ctx.save();
        ctx.setLineDash([4, 10]);
        ctx.lineDashOffset = exporting ? 0 : -(now / 40) % 14;
        stroke(strong, hl?.kind === "cycle" ? "#ff3b30" : "#ffb38f", 1.6);
        ctx.restore();
        // Arrow heads
        ctx.fillStyle = hl?.kind === "cycle" ? "#ff3b30" : "#ff8a6b";
        for (const l of strong) {
          const dx = l.target.x! - l.source.x!;
          const dy = l.target.y! - l.source.y!;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const tx = l.target.x! - ux * (l.target.r + 2);
          const ty = l.target.y! - uy * (l.target.r + 2);
          const s = 5 / Math.sqrt(t.k);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - ux * s * 1.6 - uy * s, ty - uy * s * 1.6 + ux * s);
          ctx.lineTo(tx - ux * s * 1.6 + uy * s, ty - uy * s * 1.6 - ux * s);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ---- nodes
      const labelAll = exporting || nodes.length <= 120 || t.k >= 1.4;
      const labels: SimNode[] = [];
      for (const n of nodes) {
        let fill = n.color;
        let alpha = 1;
        let ring: string | null = null;

        if (hl) {
          const d = hl.depth.get(n.id);
          if (d === undefined || !revealed(n.id)) alpha = 0.07;
          else if (n.id === hl.source) {
            fill = "#ffffff";
            ring = "#ff5330";
          } else if (hl.kind === "cycle") fill = "#ff3b30";
          else fill = d === 1 ? "#ff5330" : d === 2 ? "#ff8a4c" : "#ffb547";
        } else if (focusId) {
          if (n.id === focusId) {
            fill = "#ff5330";
            ring = "#ffffff";
          } else if (focusSet?.has(n.id)) fill = "#FFD9BC";
          else alpha = 0.16;
        }
        if (query && n.id.toLowerCase().includes(query)) {
          ring = "#ffd9bc";
          alpha = Math.max(alpha, 0.9);
        }

        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (ring) {
          ctx.lineWidth = 2 / Math.sqrt(t.k);
          ctx.strokeStyle = ring;
          ctx.stroke();
        }
        if (labelAll ? alpha > 0.5 : alpha > 0.5 && (n.id === focusId || focusSet?.has(n.id) || (hl && hl.ids.has(n.id)) || ring)) {
          labels.push(n);
        }
      }
      ctx.globalAlpha = 1;

      // Ripple on the impact source
      if (hl?.source && !exporting) {
        const src = nodes.find((n) => n.id === hl.source);
        if (src) {
          const p = (elapsed % 1600) / 1600;
          ctx.beginPath();
          ctx.arc(src.x!, src.y!, src.r + p * 40, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,83,48,${0.6 * (1 - p)})`;
          ctx.lineWidth = 2 / Math.sqrt(t.k);
          ctx.stroke();
        }
      }

      // ---- labels
      if (labels.length) {
        const fontPx = Math.max(9, Math.min(12, 11 / Math.sqrt(t.k)));
        ctx.font = `${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
        ctx.textBaseline = "middle";
        for (const n of labels.slice(0, 600)) {
          ctx.fillStyle = n.id === focusId || n.id === hl?.source ? "#ffffff" : "rgba(214,202,193,0.9)";
          ctx.fillText(fileName(n.id), n.x! + n.r + 4, n.y!);
        }
      }
      ctx.restore();
    },
    []
  );

  const renderRef = useRef<() => void>(() => {});
  const render = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    drawScene(ctx, transformRef.current, w, h, now);

    // Keep animating while the simulation runs or an emphasis animation plays.
    const sim = simRef.current;
    const p = propsRef.current;
    const simRunning = sim && sim.alpha() > sim.alphaMin();
    const animating = simRunning || (p.active && (p.highlight || hoverRef.current || p.selectedFile));
    if (animating) frameRef.current = requestAnimationFrame(() => renderRef.current());
  }, [drawScene]);

  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  const requestDraw = useCallback(() => {
    if (frameRef.current == null) frameRef.current = requestAnimationFrame(() => renderRef.current());
  }, []);

  // ---------------------------------------------------------------- helpers
  const nodeAt = useCallback((clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return null;
    const rect = canvas.getBoundingClientRect();
    const [x, y] = transformRef.current.invert([clientX - rect.left, clientY - rect.top]);
    const n = sim.find(x, y, 18 / transformRef.current.k + 4);
    return n || null;
  }, []);

  const fitTransform = useCallback((w: number, h: number, pad = 60) => {
    const nodes = nodesRef.current;
    if (!nodes.length) return d3.zoomIdentity;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x! - n.r);
      y0 = Math.min(y0, n.y! - n.r);
      x1 = Math.max(x1, n.x! + n.r + 60);
      y1 = Math.max(y1, n.y! + n.r);
    }
    const k = Math.min(3, Math.max(0.05, Math.min((w - pad * 2) / (x1 - x0 || 1), (h - pad * 2) / (y1 - y0 || 1))));
    return d3.zoomIdentity.translate(w / 2 - (k * (x0 + x1)) / 2, h / 2 - (k * (y0 + y1)) / 2).scale(k);
  }, []);

  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    const zoom = zoomRef.current;
    if (!canvas || !zoom) return;
    const { w, h } = sizeRef.current;
    d3.select(canvas).transition().duration(650).ease(d3.easeCubicOut).call(zoom.transform, fitTransform(w, h));
  }, [fitTransform]);

  useImperativeHandle(
    ref,
    () => ({
      zoomToFit,
      snapshot: (scale = 2) => {
        if (!nodesRef.current.length) return null;
        const w = 1600;
        const h = 1000;
        const off = document.createElement("canvas");
        off.width = w * scale;
        off.height = h * scale;
        const ctx = off.getContext("2d");
        if (!ctx) return null;
        ctx.scale(scale, scale);
        drawScene(ctx, fitTransform(w, h, 50), w, h, performance.now(), true);
        return off.toDataURL("image/png");
      },
    }),
    [drawScene, fitTransform, zoomToFit]
  );

  // ------------------------------------------------- canvas + interactions
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
      .scaleExtent([0.04, 8])
      .filter((event) => (!event.ctrlKey || event.type === "wheel") && !event.button)
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        requestDraw();
      });
    zoomRef.current = zoom;

    const drag = d3
      .drag<HTMLCanvasElement, unknown, SimNode | undefined>()
      .subject((event) => nodeAt(event.sourceEvent.clientX, event.sourceEvent.clientY) || undefined)
      .on("start", (event) => {
        const n = event.subject as SimNode;
        if (!event.active) simRef.current?.alphaTarget(0.25).restart();
        n.fx = n.x;
        n.fy = n.y;
        canvas.style.cursor = "grabbing";
      })
      .on("drag", (event) => {
        const n = event.subject as SimNode;
        const [x, y] = transformRef.current.invert(d3.pointer(event.sourceEvent, canvas));
        n.fx = x;
        n.fy = y;
        requestDraw();
      })
      .on("end", (event) => {
        const n = event.subject as SimNode;
        if (!event.active) simRef.current?.alphaTarget(0);
        n.fx = null;
        n.fy = null;
        canvas.style.cursor = "pointer";
      });

    const sel = d3.select(canvas);
    sel.call(drag).call(zoom).on("dblclick.zoom", null);

    const onMove = (e: MouseEvent) => {
      const n = nodeAt(e.clientX, e.clientY);
      const id = n?.id ?? null;
      const tip = tooltipRef.current;
      if (tip) {
        if (n) {
          const rect = container.getBoundingClientRect();
          tip.style.display = "block";
          tip.style.transform = `translate(${e.clientX - rect.left + 14}px, ${e.clientY - rect.top + 14}px)`;
          if (hoverRef.current !== id) {
            const nb = neighborsRef.current.get(n.id)?.size ?? 0;
            tip.innerHTML = "";
            const title = document.createElement("div");
            title.className = "cl-tip-title";
            title.textContent = n.id;
            const meta = document.createElement("div");
            meta.className = "cl-tip-meta";
            meta.textContent = `${n.lines} lines · ${nb} connections · right-click for impact`;
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
      const n = nodeAt(e.clientX, e.clientY);
      if (n) propsRef.current.onNodeClick?.(n.id);
      else propsRef.current.onBackgroundClick?.();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const n = nodeAt(e.clientX, e.clientY);
      if (n) propsRef.current.onNodeContextMenu?.(n.id, e.clientX, e.clientY);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", onContext);

    return () => {
      ro.disconnect();
      sel.on(".zoom", null).on(".drag", null);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("contextmenu", onContext);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [nodeAt, requestDraw]);

  // ----------------------------------------------------- data -> simulation
  useEffect(() => {
    simRef.current?.stop();
    if (!data) {
      nodesRef.current = [];
      linksRef.current = [];
      requestDraw();
      return;
    }

    const deg = new Map<string, number>();
    for (const l of data.links) {
      deg.set(l.source, (deg.get(l.source) || 0) + 1);
      deg.set(l.target, (deg.get(l.target) || 0) + 1);
    }
    const { w, h } = sizeRef.current;
    let cached = 0;
    const nodes: SimNode[] = data.nodes.map((n, i) => {
      const prev = positionCache.get(n.id);
      if (prev) cached++;
      const angle = i * 2.399963; // golden angle spiral seeds a stable layout
      const rad = 12 * Math.sqrt(i + 1);
      return {
        id: n.id,
        lines: n.lines || 0,
        deg: deg.get(n.id) || 0,
        r: Math.max(4, Math.min(13, 3 + Math.sqrt(n.lines || 1) / 4 + Math.sqrt(deg.get(n.id) || 0))),
        color: nodeCategoryColor(n.id),
        x: prev?.x ?? w / 2 + rad * Math.cos(angle),
        y: prev?.y ?? h / 2 + rad * Math.sin(angle),
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = [];
    const neighbors = new Map<string, Set<string>>();
    for (const n of nodes) neighbors.set(n.id, new Set());
    for (const l of data.links) {
      const s = byId.get(l.source);
      const t = byId.get(l.target);
      if (!s || !t) continue;
      links.push({ source: s, target: t, key: linkKey(s.id, t.id) });
      neighbors.get(s.id)!.add(t.id);
      neighbors.get(t.id)!.add(s.id);
    }
    nodesRef.current = nodes;
    linksRef.current = links;
    neighborsRef.current = neighbors;

    const big = nodes.length > 1500;
    const sim = d3
      .forceSimulation<SimNode, SimLink>(nodes)
      .force("link", d3.forceLink<SimNode, SimLink>(links).distance(big ? 40 : 62).strength(0.6))
      .force("charge", d3.forceManyBody<SimNode>().strength(big ? -60 : -150).theta(0.9).distanceMax(700))
      .force("collide", d3.forceCollide<SimNode>((d) => d.r + 3).iterations(1))
      .force("x", d3.forceX(w / 2).strength(0.05))
      .force("y", d3.forceY(h / 2).strength(0.05))
      .alphaDecay(big ? 0.05 : 0.028)
      .velocityDecay(0.38);

    if (cached / Math.max(1, nodes.length) > 0.8) sim.alpha(0.25);
    fittedRef.current = false;
    let ticks = 0;
    sim.on("tick", () => {
      ticks++;
      if (!fittedRef.current && ticks === 80) {
        fittedRef.current = true;
        zoomToFit();
      }
      requestDraw();
    });
    sim.on("end", () => {
      for (const n of nodes) positionCache.set(n.id, { x: n.x!, y: n.y! });
      if (!fittedRef.current) {
        fittedRef.current = true;
        zoomToFit();
      }
    });
    simRef.current = sim;
    requestDraw();

    return () => {
      sim.stop();
      for (const n of nodes) positionCache.set(n.id, { x: n.x!, y: n.y! });
    };
  }, [data, requestDraw, zoomToFit]);

  // Restart emphasis animation whenever the highlight changes.
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
    </div>
  );
});

export default ForceGraph;
