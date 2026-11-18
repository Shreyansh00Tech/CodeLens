import { useEffect, useRef, useState } from "react";

type Props = {
  /** Fired as the curtains begin to part – the page starts its entrance here. */
  onReveal: () => void;
  /** Fired once the overlay has fully left the screen. */
  onDone: () => void;
};

const COUNT_MS = 1700; // time-based, so it feels the same on every machine
const HOLD_MS = 240;
const CURTAIN_MS = 1000;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Cinematic preloader: a lens iris opens while a counter runs to 100, then the
 * two curtain halves part to reveal the page. The counter and progress bar are
 * written straight to the DOM (no re-renders) and every motion is
 * opacity/transform so it stays on the compositor.
 */
export default function LandingIntro({ onReveal, onDone }: Props) {
  const [leaving, setLeaving] = useState(false);
  const numRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef(false);
  const cbRef = useRef({ onReveal, onDone });

  useEffect(() => {
    cbRef.current = { onReveal, onDone };
  });

  useEffect(() => {
    let raf = 0;
    let fontsReady = false;
    let finished = false;
    const timers: number[] = [];
    const start = performance.now();

    const leave = () => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      if (numRef.current) numRef.current.textContent = "100";
      if (barRef.current) barRef.current.style.transform = "scaleX(1)";
      setLeaving(true);
      timers.push(window.setTimeout(() => cbRef.current.onReveal(), 380));
      timers.push(window.setTimeout(() => cbRef.current.onDone(), CURTAIN_MS + 120));
    };

    // Wait for the web fonts too (max 3s) so the hero never swaps typefaces under the curtain.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) void fonts.ready.then(() => { fontsReady = true; });
    else fontsReady = true;
    const fontGuard = window.setTimeout(() => { fontsReady = true; }, 3000);

    const tick = (now: number) => {
      if (leavingRef.current) return;
      const raw = Math.min(1, (now - start) / COUNT_MS);
      const p = fontsReady ? easeInOut(raw) : Math.min(easeInOut(raw), 0.92);
      if (numRef.current) numRef.current.textContent = String(Math.round(p * 100)).padStart(3, "0");
      if (barRef.current) barRef.current.style.transform = `scaleX(${p.toFixed(4)})`;
      if (raw >= 1 && fontsReady && !finished) {
        finished = true;
        timers.push(window.setTimeout(leave, HOLD_MS));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const skip = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") leave();
    };
    window.addEventListener("keydown", skip);

    // Hold the page still behind the overlay.
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";

    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      clearTimeout(fontGuard);
      window.removeEventListener("keydown", skip);
      html.style.overflow = prevOverflow;
    };
  }, []);

  const skipNow = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    if (numRef.current) numRef.current.textContent = "100";
    setLeaving(true);
    window.setTimeout(() => cbRef.current.onReveal(), 280);
    window.setTimeout(() => cbRef.current.onDone(), CURTAIN_MS + 20);
  };

  return (
    <div className={`cl-intro${leaving ? " is-leaving" : ""}`} role="presentation" onClick={skipNow} aria-hidden="true">
      <div className="cl-intro-curtain cl-intro-top" />
      <div className="cl-intro-curtain cl-intro-bottom" />

      <div className="cl-intro-stage">
        <div className="cl-intro-lens">
          <svg viewBox="0 0 200 200" className="cl-intro-svg" fill="none">
            <circle className="cl-intro-ring cl-r1" pathLength="1" cx="100" cy="100" r="96" />
            <circle className="cl-intro-ring cl-r2" pathLength="1" cx="100" cy="100" r="78" />
            <circle className="cl-intro-ring cl-r3" pathLength="1" cx="100" cy="100" r="58" />
            <g className="cl-intro-ticks">
              {Array.from({ length: 36 }).map((_, i) => (
                <line key={i} x1="100" y1="2" x2="100" y2={i % 3 === 0 ? 11 : 7} transform={`rotate(${i * 10} 100 100)`} />
              ))}
            </g>
          </svg>
          <div className="cl-intro-iris">
            <div className="cl-intro-core" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="cl-intro-blade" style={{ ["--a" as string]: `${i * 45}deg` }}>
                <i />
              </div>
            ))}
          </div>
        </div>

        <div className="cl-intro-word" aria-label="CodeLens">
          <span className="cl-intro-mask"><span>Code</span></span>
          <span className="cl-intro-mask cl-accent"><span>Lens</span></span>
        </div>
        <div className="cl-intro-tag">Developing the picture</div>

        <div className="cl-intro-meter">
          <span className="cl-intro-count" ref={numRef}>000</span>
          <div className="cl-intro-track"><div className="cl-intro-bar" ref={barRef} /></div>
          <span className="cl-intro-skip">click to skip</span>
        </div>
      </div>
    </div>
  );
}
