import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import LandingIntro from "../components/LandingIntro";
import "../styles/landing.css";

// ── Soft UI sounds, synthesised with Web Audio (no audio files to download) ──
let audioCtx: AudioContext | null = null;
const NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51];
function getAudio(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  audioCtx = new AC();
  return audioCtx;
}
function tone(freq: number, dur = 0.24, vol = 0.045, delay = 0) {
  const ctx = getAudio();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const lp = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  lp.type = "lowpass";
  lp.frequency.value = 2600;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(lp); lp.connect(gain); gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}
function playStep(i: number) {
  const f = NOTES[i % NOTES.length];
  tone(f);
  tone(f * 2, 0.18, 0.012, 0.045);
  if (i === NOTES.length - 1) { tone(f * 1.25, 0.5, 0.03, 0.12); tone(f * 1.5, 0.6, 0.025, 0.2); }
}

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

const flowIcon = (d: React.ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

const INTRO_KEY = "cl-intro-seen";
const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function shouldPlayIntro(): boolean {
  if (prefersReducedMotion()) return false;
  try { return sessionStorage.getItem(INTRO_KEY) !== "1"; } catch { return true; }
}

/** Headline split into words; each rises out of its own mask when the heading enters. */
function Words({ text, from = 0 }: { text: string; from?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <span key={`${w}-${i}`}>
          <span className="cl-word">
            <span className="cl-word-in" style={{ ["--w" as string]: from + i }}>{w}</span>
          </span>{" "}
        </span>
      ))}
    </>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  // `introPlaying` mounts the preloader; `ready` gates every entrance animation behind it.
  const [introPlaying, setIntroPlaying] = useState(shouldPlayIntro);
  const [ready, setReady] = useState(() => !introPlaying);
  const [wipe, setWipe] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const navCtaRef = useRef<HTMLButtonElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);

  const finishIntro = () => {
    try { sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* private mode: just replay next time */ }
    setIntroPlaying(false);
  };

  const openAnalyzer = () => {
    if (wipe) return;
    if (prefersReducedMotion()) { navigate("/analyze"); return; }
    setWipe(true);
    window.setTimeout(() => navigate("/analyze"), 560);
  };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const apertureRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const soundRef = useRef(false);
  const [sound, setSound] = useState(false);

  const toggleSound = () => {
    const next = !soundRef.current;
    soundRef.current = next;
    setSound(next);
    if (next) playStep(0); // the click is the user gesture browsers need to unlock audio
  };

  // ── Canvas graph animation (inside the aperture) ────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let animId: number;
    type N = { x: number; y: number; vx: number; vy: number; r: number; pulse: number };
    let nodes: N[] = [];

    let cssW = 0, cssH = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initNodes();
    };
    const initNodes = () => {
      nodes = Array.from({ length: 24 }, () => ({
        x: Math.random() * cssW, y: Math.random() * cssH,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.6 + 0.8, pulse: Math.random() * Math.PI * 2,
      }));
    };
    const draw = () => {
      const W = cssW, H = cssH;
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
    let raf = 0;
    let last: MouseEvent | null = null;
    const apply = () => {
      raf = 0;
      const e = last;
      if (!e) return;
      const r = hero.getBoundingClientRect();
      spot.style.setProperty("--mx", `${e.clientX - r.left}px`);
      spot.style.setProperty("--my", `${e.clientY - r.top}px`);
      if (ap) {
        const ar = ap.getBoundingClientRect();
        const cx = ar.left + ar.width / 2, cy = ar.top + ar.height / 2;
        const dx = (e.clientX - cx) / ar.width, dy = (e.clientY - cy) / ar.height;
        ap.style.transform = `rotateX(${(-dy * 10).toFixed(2)}deg) rotateY(${(dx * 10).toFixed(2)}deg)`;
      }
    };
    const onMove = (e: MouseEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    hero.addEventListener("mousemove", onMove);
    return () => { hero.removeEventListener("mousemove", onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // ── Scroll reveals: the observer only toggles a class, so React never re-renders
  // and the browser animates transform/opacity on the compositor (no main-thread work).
  useEffect(() => {
    if (!ready) return;
    const els = document.querySelectorAll<HTMLElement>("[data-reveal]");
    if (typeof IntersectionObserver === "undefined") { els.forEach((el) => el.classList.add("is-in")); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }
    }, { threshold: 0.18, rootMargin: "0px 0px -6% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ready]);

  // ── Top scroll-progress bar + magnetic CTA + feature-card tilt (all rAF-batched, transform-only) ──
  useEffect(() => {
    const bar = progressRef.current;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max).toFixed(4) : 0})`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(paint); };
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    const fine = window.matchMedia?.("(hover: hover) and (pointer: fine)").matches && !prefersReducedMotion();
    const cta = navCtaRef.current;
    const grid = featuresRef.current;
    let mRaf = 0;
    let mx = 0, my = 0;
    const magnet = (e: PointerEvent) => {
      if (!cta) return;
      const r = cta.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const near = Math.hypot(dx, dy) < 110;
      mx = near ? dx * 0.28 : 0;
      my = near ? dy * 0.4 : 0;
      if (!mRaf) mRaf = requestAnimationFrame(() => { mRaf = 0; cta.style.translate = `${mx.toFixed(1)}px ${my.toFixed(1)}px`; });
    };
    const tilt = (e: PointerEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(".cl-card");
      if (!card) return;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.style.setProperty("--ry", `${((px - 0.5) * 9).toFixed(2)}deg`);
      card.style.setProperty("--rx", `${((0.5 - py) * 9).toFixed(2)}deg`);
      card.style.setProperty("--px", `${(px * 100).toFixed(1)}%`);
      card.style.setProperty("--py", `${(py * 100).toFixed(1)}%`);
    };
    const untilt = (e: PointerEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>(".cl-card");
      if (!card) return;
      card.style.setProperty("--rx", "0deg");
      card.style.setProperty("--ry", "0deg");
    };
    if (fine) {
      window.addEventListener("pointermove", magnet, { passive: true });
      grid?.addEventListener("pointermove", tilt, { passive: true });
      grid?.addEventListener("pointerout", untilt, { passive: true });
    }
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("pointermove", magnet);
      grid?.removeEventListener("pointermove", tilt);
      grid?.removeEventListener("pointerout", untilt);
      if (raf) cancelAnimationFrame(raf);
      if (mRaf) cancelAnimationFrame(mRaf);
    };
  }, []);

  // ── Pipeline: scroll-linked progress rail, glowing packet and active-step focus ──
  // One passive scroll listener, batched to one update per frame; it only writes
  // transforms/opacity and toggles classes, so nothing triggers layout while scrolling.
  useEffect(() => {
    const flow = flowRef.current, fill = fillRef.current, dot = dotRef.current, glow = glowRef.current;
    if (!flow || !fill || !dot) return;
    const items = Array.from(flow.querySelectorAll<HTMLElement>(".cl-flow-item"));
    if (!items.length) return;
    let centers: number[] = [];
    let top = 0, span = 1, active = -1, raf = 0;

    const measure = () => {
      const base = flow.getBoundingClientRect().top + window.scrollY;
      top = base;
      centers = items.map((it) => {
        const r = it.querySelector<HTMLElement>(".cl-flow-num")!.getBoundingClientRect();
        return r.top + window.scrollY + r.height / 2 - base;
      });
      span = Math.max(1, centers[centers.length - 1] - centers[0]);
      fill.style.top = `${centers[0]}px`;
      fill.style.height = `${span}px`;
      dot.style.top = `${centers[0]}px`;
    };

    const update = () => {
      raf = 0;
      const y = window.scrollY + window.innerHeight * 0.55 - top; // reading line, relative to the flow
      const rel = Math.min(span, Math.max(0, y - centers[0]));
      fill.style.transform = `scaleY(${(rel / span).toFixed(4)})`;
      dot.style.transform = `translate3d(0, ${rel.toFixed(1)}px, 0)`;
      dot.style.opacity = y > centers[0] - 60 && y < centers[centers.length - 1] + 120 ? "1" : "0";
      if (glow) glow.style.transform = `translate3d(0, ${(Math.min(Math.max(y, 0), centers[centers.length - 1]) - 380).toFixed(1)}px, 0)`;
      let idx = -1;
      for (let i = 0; i < centers.length; i++) if (y >= centers[i] - 24) idx = i;
      if (idx !== active) {
        const prev = active;
        active = idx;
        items.forEach((it, i) => {
          it.classList.toggle("is-active", i === idx);
          it.classList.toggle("is-done", i < idx);
        });
        if (idx > prev && idx >= 0 && soundRef.current) playStep(idx);
      }
    };

    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    measure(); update();
    window.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => { measure(); onScroll(); });
    ro.observe(flow);
    ro.observe(document.body);
    return () => { window.removeEventListener("scroll", onScroll); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  type RevealKind = "up" | "side" | "focus";
  const rv = (_id: string, delay = 0, kind: RevealKind = "up") => ({
    "data-reveal": kind,
    style: { "--d": `${delay}s` } as React.CSSProperties,
  });

  const fstops = ["1.4", "2", "2.8", "4", "5.6", "8", "11", "16", "22"];
  const stack = ["JavaScript", "TypeScript", "Python", "React", "Node.js", "GitHub", "D3.js"];

  return (
    <div className="cl-root relative" data-ready={ready ? "true" : "false"}>
      {introPlaying && <LandingIntro onReveal={() => setReady(true)} onDone={finishIntro} />}
      <div className="cl-progress" aria-hidden="true"><div ref={progressRef} /></div>
      <div className="cl-grain" />
      {wipe && <div className="cl-wipe" aria-hidden="true"><span>Code<b>Lens</b></span></div>}

      <nav className="cl-nav">
        <div className="cl-nav-logo"><span className="cl-nav-ring" />Code<span className="cl-accent">Lens</span></div>
        <button ref={navCtaRef} className="cl-nav-cta" onClick={openAnalyzer}>Open the analyzer</button>
      </nav>

      {/* ── HERO ── */}
      <div className="cl-hero-wrap" ref={heroRef}>
        <div className="cl-spotlight" ref={spotlightRef} />
        <section className="cl-hero cl-section">
          <div className="cl-hero-text">
            <div className="cl-eyebrow" {...rv("eyebrow", 0, "focus")}>Code, in focus</div>
            <h1 className="cl-h1" data-reveal="words">
              <span><Words text="Bring any codebase" /></span>
              <em><Words text="into focus." from={3} /></em>
            </h1>
            <p className="cl-sub" {...rv("sub", 0.26, "focus")}>
              Paste a GitHub URL. CodeLens develops a full dependency graph —
              every file, every import, every connection — so you can see the
              whole picture before you touch a single line.
            </p>
            <p className="cl-trust" {...rv("trust", 0.34, "focus")}>No setup required · Works on any public repo</p>
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
          <div className="cl-features-grid cl-features-grid-5" ref={featuresRef}>
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
          <div className="cl-how-head" {...rv("how-header")}>
            <div>
              <div className="cl-eyebrow">Under the hood</div>
              <h2 className="cl-h2">From URL to graph.<br />Eight steps, seconds apart.</h2>
            </div>
            <button type="button" className={`cl-sound${sound ? " is-on" : ""}`} aria-pressed={sound} onClick={toggleSound} title="Soft sounds while you scroll through the steps">
              <span className="cl-sound-bars" aria-hidden="true"><i /><i /><i /><i /></span>
              {sound ? "Sound on" : "Sound off"}
            </button>
          </div>
          <div className="cl-flow" ref={flowRef}>
            <div className="cl-flow-glow" ref={glowRef} aria-hidden="true" />
            <div className="cl-flow-fill" ref={fillRef} aria-hidden="true" />
            <div className="cl-flow-dot" ref={dotRef} aria-hidden="true" />
            {[
              { n: "01", title: "Submit a repository URL", desc: "The developer pastes a GitHub repository URL into CodeLens.", icon: flowIcon(<><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></>) },
              { n: "02", title: "Shallow clone the repo", desc: "The backend clones the repository locally — fast and lightweight, no full history.", icon: flowIcon(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>) },
              { n: "03", title: "Parse every source file", desc: "An AST / Tree-sitter parser scans each file and extracts its structure — classes, functions, imports, and API endpoints.", tag: "AST · Tree-sitter", icon: flowIcon(<><path d="M8 8l-4 4 4 4" /><path d="M16 8l4 4-4 4" /><path d="M13.5 5l-3 14" /></>) },
              { n: "04", title: "Build the graph", desc: "Files, classes, and APIs become nodes. Calls, imports, and dependencies become edges.", icon: flowIcon(<><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="M8.3 7l7.4 .8M7.4 8.3l1 7.3M16.6 10.2l-5.8 6.2" /></>) },
              { n: "05", title: "Store in a graph database", desc: "The graph is stored in Neo4j, built specifically for fast relationship-based queries.", tag: "Neo4j", icon: flowIcon(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" /><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" /></>) },
              { n: "06", title: "Process large repos asynchronously", desc: "For bigger repositories, processing runs in the background via Kafka, keeping the interface fast and responsive.", tag: "Kafka", icon: flowIcon(<><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /><path d="M3 17.5l9 5 9-5" /></>) },
              { n: "07", title: "Generate code embeddings", desc: "Embeddings are generated and stored so an AI model can later answer natural-language questions grounded in the real code.", tag: "PostgreSQL · pgvector", icon: flowIcon(<><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></>) },
              { n: "08", title: "Render the interactive graph", desc: "The React frontend fetches the graph data and renders it as an interactive, clickable architecture diagram.", icon: flowIcon(<><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 9h18" /><circle cx="8" cy="14.5" r="1.4" /><circle cx="15.5" cy="13" r="1.4" /><path d="M9.3 14l5-.7" /></>) },
            ].map(({ n, title, desc, tag, icon }, i) => (
              <div key={n} {...rv(`flow-${n}`, 0, "side")} className="cl-flow-item">
                <div className="cl-flow-num-col">
                  <div className="cl-flow-num">{n}</div>
                  {i < 7 && <div className="cl-flow-line" />}
                </div>
                <div className="cl-flow-content">
                  <article className="cl-flow-card" data-n={n}>
                    <div className="cl-flow-card-top">
                      <span className="cl-flow-step">Step {n}</span>
                      <span className="cl-flow-icon">{icon}</span>
                    </div>
                    <div className="cl-flow-title">{title}</div>
                    <div className="cl-flow-desc">{desc}</div>
                    {tag && <span className="cl-flow-tag">{tag}</span>}
                  </article>
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
