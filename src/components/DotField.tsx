"use client";

// Interactive dot-grid background (adapted from React Bits "DotField").
// Hardened for an always-open operational dashboard:
//   • theme-friendly defaults (blue/slate dots on the dark bg)
//   • mouse mapping via clientX/Y − the canvas's current rect (correct inside a
//     scrolling/sticky container, unlike the original's page-coord math)
//   • prefers-reduced-motion → draw a STATIC field once (no rAF, no listeners)
//   • pause the rAF loop when the tab is hidden (Page Visibility)
//   • idle-stop: once the cursor settles, the loop halts until the next move —
//     so it is NOT a perpetual 60fps redraw while you stare at the dashboard
// Pure canvas + SVG; no external dependencies.

import { useEffect, useRef, memo } from "react";

const TWO_PI = Math.PI * 2;

interface Dot {
  ax: number;
  ay: number;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

export interface DotFieldProps {
  dotRadius?: number;
  dotSpacing?: number;
  cursorRadius?: number;
  cursorForce?: number;
  bulgeOnly?: boolean;
  bulgeStrength?: number;
  sparkle?: boolean;
  waveAmplitude?: number;
  gradientFrom?: string;
  gradientTo?: string;
  className?: string;
}

const DotField = memo(function DotField({
  dotRadius = 2.0,
  dotSpacing = 24,
  cursorRadius = 320,
  cursorForce = 0.1,
  bulgeOnly = true,
  bulgeStrength = 60,
  sparkle = false,
  waveAmplitude = 0,
  gradientFrom = "rgba(96, 165, 250, 0.45)",
  gradientTo = "rgba(148, 163, 184, 0.24)",
  className = "",
}: DotFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotsRef = useRef<Dot[]>([]);
  const mouseRef = useRef({ x: -9999, y: -9999, prevX: -9999, prevY: -9999, speed: 0 });
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, left: 0, top: 0 });
  const engagement = useRef(0);
  const propsRef = useRef({
    dotRadius,
    dotSpacing,
    cursorRadius,
    cursorForce,
    bulgeOnly,
    bulgeStrength,
    sparkle,
    waveAmplitude,
    gradientFrom,
    gradientTo,
  });

  // Keep the rAF loop reading fresh props without re-subscribing (updated post-render).
  useEffect(() => {
    propsRef.current = {
      dotRadius,
      dotSpacing,
      cursorRadius,
      cursorForce,
      bulgeOnly,
      bulgeStrength,
      sparkle,
      waveAmplitude,
      gradientFrom,
      gradientTo,
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function buildDots(w: number, h: number) {
      const p = propsRef.current;
      const step = p.dotRadius + p.dotSpacing;
      const cols = Math.floor(w / step);
      const rows = Math.floor(h / step);
      const padX = (w % step) / 2;
      const padY = (h % step) / 2;
      const dots: Dot[] = new Array(Math.max(0, rows * cols));
      let idx = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const ax = padX + col * step + step / 2;
          const ay = padY + row * step + step / 2;
          dots[idx++] = { ax, ay, sx: ax, sy: ay, vx: 0, vy: 0, x: ax, y: ay };
        }
      }
      dotsRef.current = dots;
    }

    function paint(animated: boolean, frameCount: number) {
      if (!ctx) return;
      const dots = dotsRef.current;
      const m = mouseRef.current;
      const { w, h } = sizeRef.current;
      const p = propsRef.current;
      const len = dots.length;
      const t = frameCount * 0.02;
      const eng = engagement.current;

      ctx.clearRect(0, 0, w, h);
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, p.gradientFrom);
      grad.addColorStop(1, p.gradientTo);
      ctx.fillStyle = grad;

      const cr = p.cursorRadius;
      const crSq = cr * cr;
      const rad = p.dotRadius / 2;
      const isBulge = p.bulgeOnly;

      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const d = dots[i];
        if (animated) {
          const dx = m.x - d.ax;
          const dy = m.y - d.ay;
          const distSq = dx * dx + dy * dy;
          if (distSq < crSq && eng > 0.01) {
            const dist = Math.sqrt(distSq) || 0.0001;
            if (isBulge) {
              const tt = 1 - dist / cr;
              const push = tt * tt * p.bulgeStrength * eng;
              const angle = Math.atan2(dy, dx);
              d.sx += (d.ax - Math.cos(angle) * push - d.sx) * 0.15;
              d.sy += (d.ay - Math.sin(angle) * push - d.sy) * 0.15;
            } else {
              const angle = Math.atan2(dy, dx);
              const move = (500 / dist) * (m.speed * p.cursorForce);
              d.vx += Math.cos(angle) * -move;
              d.vy += Math.sin(angle) * -move;
            }
          } else if (isBulge) {
            d.sx += (d.ax - d.sx) * 0.1;
            d.sy += (d.ay - d.sy) * 0.1;
          }
          if (!isBulge) {
            d.vx *= 0.9;
            d.vy *= 0.9;
            d.x = d.ax + d.vx;
            d.y = d.ay + d.vy;
            d.sx += (d.x - d.sx) * 0.1;
            d.sy += (d.y - d.sy) * 0.1;
          }
        }

        let drawX = animated ? d.sx : d.ax;
        let drawY = animated ? d.sy : d.ay;
        if (animated && p.waveAmplitude > 0) {
          drawY += Math.sin(d.ax * 0.03 + t) * p.waveAmplitude;
          drawX += Math.cos(d.ay * 0.03 + t * 0.7) * p.waveAmplitude * 0.5;
        }
        if (animated && p.sparkle) {
          const hash = ((i * 2654435761) ^ (frameCount >> 3)) >>> 0;
          const r = hash % 100 < 3 ? rad * 1.8 : rad;
          ctx.moveTo(drawX + r, drawY);
          ctx.arc(drawX, drawY, r, 0, TWO_PI);
        } else {
          ctx.moveTo(drawX + rad, drawY);
          ctx.arc(drawX, drawY, rad, 0, TWO_PI);
        }
      }
      ctx.fill();
    }

    function doResize() {
      const parent = canvas?.parentElement;
      if (!parent || !ctx || !canvas) return;
      const rect = parent.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w, h, left: rect.left, top: rect.top };
      buildDots(w, h);
      if (reduceMotion) paint(false, 0);
    }

    let resizeTimer: number | undefined;
    function resize() {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(doResize, 100);
    }

    doResize();
    window.addEventListener("resize", resize);

    // Track the CONTAINER's box, not just the window — the canvas must re-cover when the sidebar
    // hover-expands/collapses (64↔200px), a scrollbar appears, or the page reflows as data loads.
    // None of those fire a window 'resize', so without this the dot-field leaves a stale gap.
    const parentEl = canvas.parentElement;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
    if (ro && parentEl) ro.observe(parentEl);

    // Reduced motion: a single static field, no loop / pointer interaction.
    if (reduceMotion) {
      return () => {
        ro?.disconnect();
        window.clearTimeout(resizeTimer);
        window.removeEventListener("resize", resize);
      };
    }

    function onMouseMove(e: MouseEvent) {
      const s = sizeRef.current;
      mouseRef.current.x = e.clientX - s.left;
      mouseRef.current.y = e.clientY - s.top;
      idleFrames = 0;
      start(); // wake the loop if it idle-stopped
    }

    function updateMouseSpeed() {
      const m = mouseRef.current;
      const dx = m.prevX - m.x;
      const dy = m.prevY - m.y;
      m.speed += (Math.sqrt(dx * dx + dy * dy) - m.speed) * 0.5;
      if (m.speed < 0.001) m.speed = 0;
      m.prevX = m.x;
      m.prevY = m.y;
    }
    const speedInterval = window.setInterval(updateMouseSpeed, 20);

    let frameCount = 0;
    let idleFrames = 0;

    function tick() {
      frameCount++;
      const m = mouseRef.current;
      const targetEngagement = Math.min(m.speed / 5, 1);
      engagement.current += (targetEngagement - engagement.current) * 0.06;
      if (engagement.current < 0.001) engagement.current = 0;

      paint(true, frameCount);

      // Idle-stop: once the field has fully settled, halt until the next mouse move.
      if (engagement.current === 0) idleFrames++;
      else idleFrames = 0;
      if (idleFrames > 45) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    function start() {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
    }
    function stop() {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    window.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      ro?.disconnect();
      window.clearInterval(speedInterval);
      window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className={`relative h-full w-full ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
    </div>
  );
});

export default DotField;
