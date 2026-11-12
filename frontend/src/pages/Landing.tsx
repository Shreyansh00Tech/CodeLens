import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import GhostCursor from "../Component"; // Adjust path to GhostCursor component if needed
import "../styles/landing.css";

function AnimatedNumber({ target, suffix = "" }: { target: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setStarted(true); }, { threshold: 0.5 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    const el = ref.current!;
    const duration = 1400;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [started, target, suffix]);

  return <span ref={ref}>0{suffix}</span>;
}

export default function Landing() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const apertureRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set());

  // ── Canvas graph animation (inside the aperture) ────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let animId: number;
    type N = { x: number; y: number; vx: number; vy: number; r: number; pulse: number };
    let nodes: N[] = [];

    const resize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      initNodes();
    };
    const initNodes = () => {
      nodes = Array.from({ length: 24 }, () => ({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.6 + 0.8, pulse: Math.random() * Math.PI * 2,
      }));
    };
    const draw = () => {
      const { width: W, height: H } = canvas;
      ctx.clearRect(0, 0, W, H);
      for (const n of nodes) {
        n.x += n.vx; n.y += n.vy; n.pulse += 0.012;
        if (n.x < 0 || n.x > W) n.vx *= -1;
        if (n.y < 0 || n.y > H) n.vy *= -1;
      }
      const maxD = 92;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < maxD) {
            const a = (1 - d / maxD) * 0.4;
            ctx.strokeStyle = `rgba(255,90,54,${a})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.stroke();
          }
        }
      }
      for (const n of nodes) {
        const p = 0.5 + 0.5 * Math.sin(n.pulse);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * (0.85 + 0.2 * p), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(16,13,11,${0.55 + 0.35 * p})`;
        ctx.fill();
      }
      animId = onScreen && !document.hidden ? requestAnimationFrame(draw) : 0;
    };
    // Pause the aperture animation when it is scrolled away or the tab is hidden.
    let onScreen = true;
    const resume = () => { if (!animId && onScreen && !document.hidden) animId = requestAnimationFrame(draw); };
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; resume(); });
    io.observe(canvas);
    document.addEventListener("visibilitychange", resume);
    resize(); draw();
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(animId); io.disconnect(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("resize", resize); };
  }, []);

  // ── Cursor-tracked focus spotlight + aperture tilt ──────────────────────
  useEffect(() => {
    const hero = heroRef.current!;
    const spot = spotlightRef.current!;
    const ap = apertureRef.current;
    const onMove = (e: MouseEvent) => {
      const r = hero.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      spot.style.setProperty("--mx", `${x}px`);
      spot.style.setProperty("--my", `${y}px`);
      if (ap) {
        const ar = ap.getBoundingClientRect();
        const cx = ar.left + ar.width / 2, cy = ar.top + ar.height / 2;
        const dx = (e.clientX - cx) / ar.width, dy = (e.clientY - cy) / ar.height;
        ap.style.transform = `rotateX(${(-dy * 10).toFixed(2)}deg) rotateY(${(dx * 10).toFixed(2)}deg)`;
      }
    };
    hero.addEventListener("mousemove", onMove);
    return () => hero.removeEventListener("mousemove", onMove);
  }, []);

  // ── Scroll-based blur-to-focus reveals ───────────────────────────────────
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) setVisible((prev) => new Set([...prev, e.target.id])); });
    }, { threshold: 0.12 });
    document.querySelectorAll("[data-reveal]").forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const rv = (id: string, delay = 0) => ({
    id,
    "data-reveal": true,
    style: {
      opacity: visible.has(id) ? 1 : 0,
      filter: visible.has(id) ? "blur(0px)" : "blur(10px)",
      transform: visible.has(id) ? "translateY(0) scale(1)" : "translateY(24px) scale(0.985)",
      transition: `opacity 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}s, filter 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}s, transform 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}s`,
    } as React.CSSProperties,
  });

  const fstops = ["1.4", "2", "2.8", "4", "5.6", "8", "11", "16", "22"];
  const stack = ["JavaScript", "TypeScript", "Python", "React", "Node.js", "GitHub", "D3.js"];

  return (
    <div className="cl-root relative">
      {/* GhostCursor Integration matching CodeLens theme (#ff5330) */}
      <GhostCursor
        color="#ff5330"
        brightness={1.3}
        trailLength={25}
        inertia={0.45}
        bloomStrength={0.4}
        bloomRadius={0.8}
        bloomThreshold={0.01}
        mixBlendMode="screen"
        zIndex={2}
      />

      <div className="cl-grain" />

      <nav className="cl-nav">
        <div className="cl-nav-logo"><span className="cl-nav-ring" />Code<span className="cl-accent">Lens</span></div>
        <div className="cl-nav-links">
          <button className="cl-nav-link" onClick={() => navigate("/analyze")}>Live demo</button>
        </div>
        <button className="cl-nav-cta" onClick={() => navigate("/analyze")}>Open the analyzer</button>
      </nav>

      {/* ── HERO ── */}
      <div className="cl-hero-wrap" ref={heroRef}>
        <div className="cl-spotlight" ref={spotlightRef} />
        <section className="cl-hero cl-section">
          <div className="cl-hero-text">
            <div className="cl-eyebrow" {...rv("eyebrow")}>Code, in focus</div>
            <h1 className="cl-h1">
              <span {...rv("h1a", 0.06)} style={{ display: "block", ...rv("h1a", 0.06).style }}>Bring any codebase</span>
              <em {...rv("h1b", 0.16)} style={{ display: "block", ...rv("h1b", 0.16).style }}>into focus.</em>
            </h1>
            <p className="cl-sub" {...rv("sub", 0.26)}>
              Paste a GitHub URL. CodeLens develops a full dependency graph —
              every file, every import, every connection — so you can see the
              whole picture before you touch a single line.
            </p>
            <div className="cl-ctas" {...rv("cta", 0.34)}>
              <button className="cl-btn-primary" data-text="Open the analyzer" onClick={() => navigate("/analyze")}>
                <span>Open the analyzer</span>
              </button>
            </div>
            <p className="cl-trust" {...rv("trust", 0.4)}>No setup required · Works on any public repo</p>
          </div>

          <div className="cl-aperture-outer" {...rv("aperture", 0.15)}>
            <div className="cl-aperture" ref={apertureRef}>
              <canvas ref={canvasRef} className="cl-aperture-canvas" />
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="cl-blade" style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${i * 0.06}s` }} />
              ))}
              <div className="cl-aperture-ring">
                {fstops.map((f) => <span key={f} className="cl-fstop">{f}</span>)}
              </div>
              <div className="cl-aperture-glow" />
            </div>
            <span className="cl-aperture-caption">focal length: entire repository</span>
          </div>
        </section>
      </div>

      {/* ── PROOF (marquee) ── */}
      <section className="cl-proof">
        <div className="cl-marquee">
          <div className="cl-marquee-track">
            {[...stack, ...stack].map((l, i) => <span key={i} className="cl-proof-item">{l}</span>)}
          </div>
        </div>
      </section>

      {/* ── STATS ── */}
      <section className="cl-stats cl-section">
        <div className="cl-container cl-stats-grid">
          <div {...rv("s1")} className="cl-stat"><div className="cl-stat-num"><AnimatedNumber target={2} suffix="+" /></div><div className="cl-stat-label">Repos analyzed</div></div>
          <div {...rv("s2", 0.08)} className="cl-stat"><div className="cl-stat-num"><AnimatedNumber target={5} suffix="+" /></div><div className="cl-stat-label">Files mapped</div></div>
          <div {...rv("s3", 0.16)} className="cl-stat"><div className="cl-stat-num"><AnimatedNumber target={4} suffix="s" /></div><div className="cl-stat-label">Avg. analysis time</div></div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="cl-features cl-section cl-invert">
        <div className="cl-container">
          <div {...rv("feat-header")}>
            <div className="cl-eyebrow">Capabilities</div>
            <h2 className="cl-h2">Everything you need to<br />see clearly</h2>
          </div>
          <div className="cl-features-grid cl-features-grid-5">
            {[
              {
                id: "f1", title: "Architecture Visualization",
                desc: "The entire codebase is displayed as an interactive, force-directed graph — explore structure visually instead of digging through folders.",
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/><line x1="6" y1="6" x2="10" y2="11"/><line x1="18" y1="6" x2="14" y2="11"/><line x1="6" y1="18" x2="10" y2="13"/><line x1="18" y1="18" x2="14" y2="13"/></svg>,
              },
              {
                id: "f2", title: "API Flow Tracing",
                desc: "Select a specific API — like POST /orders — and instantly see its complete journey: controller → service → downstream dependencies.",
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h16M4 12h10M4 18h16"/><path d="M17 9l3 3-3 3"/></svg>,
              },
              {
                id: "f3", title: "Change Impact Analysis",
                desc: "Select any class or method and see exactly which components, services, or tests could break — before you ever hit save.",
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
              },
              {
                id: "f4", title: "Architecture Problem Detection",
                desc: "Graph algorithms automatically surface circular dependencies, tightly coupled classes, and potentially dead code.",
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M17.5 3.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/><path d="M4 21h16"/></svg>,
              },
              {
                id: "f5", title: "AI-Powered Codebase Q&A",
                desc: "Ask plain-language questions like \u2018How does authentication work?\u2019 and get answers grounded in the real repository via RAG — not a generic reply.",
                icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
              },
            ].map(({ id, title, desc, icon }, i) => (
              <div key={id} {...rv(id, i * 0.08)} className="cl-card">
                <div className="cl-card-icon">{icon}</div>
                <div className="cl-card-title">{title}</div>
                <div className="cl-card-desc">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="cl-how cl-section">
        <div className="cl-container">
          <div {...rv("how-header")}>
            <div className="cl-eyebrow">Under the hood</div>
            <h2 className="cl-h2">From URL to graph.<br />Eight steps, seconds apart.</h2>
          </div>
          <div className="cl-flow">
            {[
              { n: "01", title: "Submit a repository URL", desc: "The developer pastes a GitHub repository URL into CodeLens." },
              { n: "02", title: "Shallow clone the repo", desc: "The backend clones the repository locally — fast and lightweight, no full history." },
              { n: "03", title: "Parse every source file", desc: "An AST / Tree-sitter parser scans each file and extracts its structure — classes, functions, imports, and API endpoints.", tag: "AST · Tree-sitter" },
              { n: "04", title: "Build the graph", desc: "Files, classes, and APIs become nodes. Calls, imports, and dependencies become edges." },
              { n: "05", title: "Store in a graph database", desc: "The graph is stored in Neo4j, built specifically for fast relationship-based queries.", tag: "Neo4j" },
              { n: "06", title: "Process large repos asynchronously", desc: "For bigger repositories, processing runs in the background via Kafka, keeping the interface fast and responsive.", tag: "Kafka" },
              { n: "07", title: "Generate code embeddings", desc: "Embeddings are generated and stored so an AI model can later answer natural-language questions grounded in the real code.", tag: "PostgreSQL · pgvector" },
              { n: "08", title: "Render the interactive graph", desc: "The React frontend fetches the graph data and renders it as an interactive, clickable architecture diagram." },
            ].map(({ n, title, desc, tag }, i) => (
              <div key={n} {...rv(`flow-${n}`, i * 0.05)} className="cl-flow-item">
                <div className="cl-flow-num-col">
                  <div className="cl-flow-num">{n}</div>
                  {i < 7 && <div className="cl-flow-line" />}
                </div>
                <div className="cl-flow-content">
                  <div className="cl-flow-title">{title}</div>
                  <div className="cl-flow-desc">{desc}</div>
                  {tag && <span className="cl-flow-tag">{tag}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── VALUE ── */}
      <section className="cl-value cl-section cl-invert">
        <div className="cl-container">
          <div {...rv("val-header")}>
            <div className="cl-eyebrow">Why it matters</div>
            <h2 className="cl-h2">Stop guessing.<br /><em>Start seeing.</em></h2>
          </div>
          <div className="cl-value-grid">
            {[
              { id: "v1", title: "Save hours of onboarding", desc: "New to a codebase? The graph shows the architecture in thirty seconds, not three days of file-hunting." },
              { id: "v2", title: "Reduce cognitive load", desc: "A graph is easier to reason about than a hundred open tabs and a half-remembered import chain." },
              { id: "v3", title: "Understand at any scale", desc: "Works as well on a fifty-file side project as it does on a five-thousand-file monorepo." },
            ].map(({ id, title, desc }, i) => (
              <div key={id} {...rv(id, i * 0.1)} className="cl-value-item">
                <div className="cl-value-title">{title}</div>
                <div className="cl-value-desc">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="cl-final cl-section cl-invert">
        <div className="cl-container-sm">
          <div {...rv("final-cta")}>
            <h2 className="cl-h2-lg">Ready to develop<br />the picture?</h2>
            <p className="cl-final-sub">Paste a GitHub URL and see your first graph in under sixty seconds. No account, no card — just a codebase, in focus.</p>
            <button className="cl-btn-primary" data-text="Start exploring" onClick={() => navigate("/analyze")}>
              <span>Start exploring</span>
            </button>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="cl-footer cl-invert">
        <div className="cl-nav-logo">Code<span className="cl-accent">Lens</span></div>
        <div className="cl-footer-links">{["GitHub", "Docs", "Privacy", "Contact"].map((l) => <span key={l} className="cl-footer-link">{l}</span>)}</div>
        <span className="cl-footer-copy">© {new Date().getFullYear()} CodeLens</span>
      </footer>
    </div>
  );
}
