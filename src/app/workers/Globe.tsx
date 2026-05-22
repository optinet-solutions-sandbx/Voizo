// src/app/workers/Globe.tsx
//
// 3D orthographic globe with worker pins.
// - Pin position derives from the leased campaign timezone (TIMEZONE_COORDS).
// - Pin color per design doc §5.2:
//     blue   — leased + in-flight call (pulses)
//     amber  — leased + idle
//     red    — maintenance
//   Free workers do NOT pin.
// - Drag to rotate (no auto-spin), country hover shows local time.
// - Selected pin pins a floating detail card next to it.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, MapPin, Phone } from "lucide-react";
import * as d3geo from "d3-geo";
import * as topojson from "topojson-client";
import type { GeoPermissibleObjects } from "d3-geo";

import type { WorkerSlot } from "./use-workers-state";
import {
  coordsForTimezone, formatCallDuration, formatLocalTime,
} from "./timezone-coords";

// ─────────────────────────────────────────────────────────────────────────
// World atlas — self-hosted at /public/countries-110m.json (~110KB).
// Fetched once per session and cached in-module via __worldPromise.
// ─────────────────────────────────────────────────────────────────────────

const WORLD_ATLAS_URL = "/countries-110m.json";

interface WorldFeatures {
  land: GeoPermissibleObjects;
  countries: Array<{ id: string | number; properties: { name?: string } } & GeoPermissibleObjects>;
  borders: GeoPermissibleObjects;
}

let __worldPromise: Promise<WorldFeatures> | null = null;
function loadWorldOnce(): Promise<WorldFeatures> {
  if (!__worldPromise) {
    __worldPromise = fetch(WORLD_ATLAS_URL)
      .then(r => r.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((world: any) => ({
        land: topojson.feature(world, world.objects.land) as unknown as GeoPermissibleObjects,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        countries: (topojson.feature(world, world.objects.countries) as any).features,
        borders: topojson.mesh(world, world.objects.countries, (a, b) => a !== b) as unknown as GeoPermissibleObjects,
      }))
      .catch((err) => {
        // Reset so subsequent mounts can retry
        __worldPromise = null;
        throw err;
      });
  }
  return __worldPromise;
}

function useWorldFeatures(): WorldFeatures | null {
  const [features, setFeatures] = useState<WorldFeatures | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadWorldOnce().then(f => { if (!cancelled) setFeatures(f); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return features;
}

// ─────────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

type PinColor = "blue" | "amber" | "red";
function pinColorForSlot(slot: WorkerSlot): PinColor | null {
  if (slot.status === "maintenance") return "red";
  if (slot.status === "leased") return slot.inFlightCall ? "blue" : "amber";
  return null;
}

// Country name → best-effort IANA timezone for the hover tooltip.
// Trimmed to major countries; falls back to longitude-derived Etc/GMT.
const COUNTRY_TZ: Record<string, string> = {
  "United States of America": "America/New_York",
  "Canada": "America/Toronto", "Mexico": "America/Mexico_City",
  "Brazil": "America/Sao_Paulo", "Argentina": "America/Argentina/Buenos_Aires",
  "United Kingdom": "Europe/London", "Ireland": "Europe/Dublin",
  "France": "Europe/Paris", "Spain": "Europe/Madrid", "Germany": "Europe/Berlin",
  "Italy": "Europe/Rome", "Netherlands": "Europe/Amsterdam",
  "Sweden": "Europe/Stockholm", "Norway": "Europe/Oslo", "Poland": "Europe/Warsaw",
  "Greece": "Europe/Athens", "Russia": "Europe/Moscow", "Turkey": "Europe/Istanbul",
  "United Arab Emirates": "Asia/Dubai", "Saudi Arabia": "Asia/Riyadh",
  "Israel": "Asia/Jerusalem", "Iran": "Asia/Tehran", "Egypt": "Africa/Cairo",
  "India": "Asia/Kolkata", "Pakistan": "Asia/Karachi", "Bangladesh": "Asia/Dhaka",
  "Thailand": "Asia/Bangkok", "Vietnam": "Asia/Ho_Chi_Minh",
  "Indonesia": "Asia/Jakarta", "Malaysia": "Asia/Kuala_Lumpur",
  "Singapore": "Asia/Singapore", "Philippines": "Asia/Manila",
  "China": "Asia/Shanghai", "Japan": "Asia/Tokyo", "South Korea": "Asia/Seoul",
  "Australia": "Australia/Sydney", "New Zealand": "Pacific/Auckland",
  "South Africa": "Africa/Johannesburg", "Nigeria": "Africa/Lagos",
  "Kenya": "Africa/Nairobi", "Morocco": "Africa/Casablanca",
};

function approxTZFromLon(lon: number): string {
  const hours = Math.round(lon / 15);
  if (hours === 0) return "UTC";
  return `Etc/GMT${hours >= 0 ? "-" : "+"}${Math.abs(hours)}`;
}

// ─────────────────────────────────────────────────────────────────────────

interface GlobeProps {
  slots: WorkerSlot[];
  now: Date;
  hoveredSlotIndex: number | null;
  selectedSlotIndex: number | null;
  onSlotHover: (slotIndex: number | null) => void;
  onSlotSelect: (slotIndex: number | null) => void;
  theme: "dark" | "light";
}

export default function Globe({
  slots, now,
  hoveredSlotIndex, selectedSlotIndex,
  onSlotHover, onSlotSelect,
  theme,
}: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const features = useWorldFeatures();

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [rotDeg, setRotDeg] = useState(-110);
  const [tiltDeg, setTiltDeg] = useState(-15);
  const [isDragging, setIsDragging] = useState(false);

  const [cursorPos, setCursorPos] = useState<{x: number; y: number} | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [hoveredCountry, setHoveredCountry] = useState<any | null>(null);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const cr = e.contentRect;
        setSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Initial rotation: center on the first leased worker's city, if any
  useEffect(() => {
    const first = slots.find(s => s.campaign);
    if (!first) return;
    const c = coordsForTimezone(first.campaign?.timezone);
    if (!c) return;
    setRotDeg(-c.lon);
    setTiltDeg(clamp(-c.lat * 0.5, -85, 85));
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // P4: Pan-to-pin when selectedSlotIndex changes. Triggers on panel clicks,
  // pin clicks, and ?focus=<slot> URL param arrivals. Skip if the user is
  // mid-drag (don't fight them) or if the slot has no campaign (free
  // workers have no globe location). Animates rotDeg/tiltDeg over ~600ms
  // with ease-in-out cubic. Shortest-path longitude (wraps delta to
  // [-180, 180]) so AU→UK pans the short way around.
  useEffect(() => {
    if (selectedSlotIndex == null) return;
    const slot = slots.find(s => s.slotIndex === selectedSlotIndex);
    if (!slot?.campaign) return;
    const c = coordsForTimezone(slot.campaign.timezone);
    if (!c) return;

    const startRot = rotDeg;
    const startTilt = tiltDeg;
    const targetRot = -c.lon;
    const targetTilt = clamp(-c.lat * 0.5, -85, 85);

    let deltaRot = targetRot - startRot;
    if (deltaRot > 180) deltaRot -= 360;
    if (deltaRot < -180) deltaRot += 360;
    const deltaTilt = targetTilt - startTilt;

    // Already centered — don't animate a 0-degree pan.
    if (Math.abs(deltaRot) < 1 && Math.abs(deltaTilt) < 1) return;

    const duration = 600;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      setRotDeg(startRot + deltaRot * eased);
      setTiltDeg(startTilt + deltaTilt * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Intentionally only depend on selectedSlotIndex: don't re-trigger on
    // rotDeg/tiltDeg changes (would feedback-loop with our own setState) or
    // on slots polling refresh (would re-pan every 5s).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlotIndex]);

  const cx = size.w / 2;
  const cy = size.h / 2;
  const R = Math.min(size.w, size.h) * 0.42;

  const projection = useMemo(() => {
    return d3geo.geoOrthographic()
      .scale(R)
      .translate([cx, cy])
      .clipAngle(90)
      .precision(0.5);
  }, [R, cx, cy]);

  projection.rotate([rotDeg, tiltDeg]);
  const pathGen = d3geo.geoPath(projection);

  // ── Drag handling ───────────────────────────────────────────────────────
  const dragRef = useRef<{startX:number;startY:number;startRot:number;startTilt:number;moved:boolean} | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-pin]")) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startRot: rotDeg, startTilt: tiltDeg,
      moved: false,
    };
    setIsDragging(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }, [rotDeg, tiltDeg]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cxr = e.clientX - rect.left;
    const cyr = e.clientY - rect.top;
    setCursorPos({ x: cxr, y: cyr });

    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
      setRotDeg(dragRef.current.startRot + dx * 0.4);
      setTiltDeg(clamp(dragRef.current.startTilt - dy * 0.35, -85, 85));
      setHoveredCountry(null);
      return;
    }
    if (!features?.countries) { setHoveredCountry(null); return; }
    const lonlat = projection.invert?.([cxr, cyr]);
    if (!lonlat) { setHoveredCountry(null); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let found: any = null;
    for (const f of features.countries) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (d3geo.geoContains(f as any, lonlat as [number, number])) { found = f; break; }
    }
    setHoveredCountry(found);
  }, [projection, features]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const moved = dragRef.current?.moved;
    dragRef.current = null;
    setIsDragging(false);
    if (!moved && !(e.target as HTMLElement).closest("[data-pin]")) {
      onSlotSelect(null);
    }
  }, [onSlotSelect]);

  const handlePointerLeave = useCallback(() => {
    setCursorPos(null);
    setHoveredCountry(null);
  }, []);

  // ── Project pinned slots ───────────────────────────────────────────────
  interface ProjectedPin {
    slot: WorkerSlot;
    color: PinColor;
    coords: ReturnType<typeof coordsForTimezone>;
    x: number;
    y: number;
    visible: boolean;
  }
  const pinnedSlots = useMemo<ProjectedPin[]>(() => {
    const out: ProjectedPin[] = [];
    for (const s of slots) {
      const color = pinColorForSlot(s);
      if (!color) continue;
      const coords = s.campaign ? coordsForTimezone(s.campaign.timezone) : null;
      if (!coords) continue;
      const pt = projection([coords.lon, coords.lat]);
      out.push({
        slot: s,
        color,
        coords,
        x: pt ? pt[0] : 0,
        y: pt ? pt[1] : 0,
        visible: !!pt,
      });
    }
    return out;
  // projection is mutated in place by projection.rotate([rotDeg, tiltDeg])
  // every render, so its identity doesn't change. We MUST depend on the
  // rotation values directly so pin positions re-derive while dragging —
  // without these the pins freeze on screen-space and only "jump" to the
  // correct lat/lon every 5s when the workers state poll lands. The lint
  // rule sees the mutation as unused so flags these as "unnecessary".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, projection, rotDeg, tiltDeg]);

  // Graticule (drawn once)
  const graticule = useMemo(() => d3geo.geoGraticule().step([30, 30])(), []);

  const stars = useMemo(() => {
    const arr: {x:number;y:number;r:number;o:number}[] = [];
    let seed = 9301;
    for (let i = 0; i < 120; i++) {
      seed = (seed * 9301 + 49297) % 233280; const a = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280; const b = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280; const c = seed / 233280;
      arr.push({ x: a, y: b, r: 0.3 + c * 0.8, o: 0.2 + c * 0.5 });
    }
    return arr;
  }, []);

  // ─────────────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef}
         className="absolute inset-0 select-none touch-none"
         style={{ cursor: isDragging ? "grabbing" : "grab" }}
         onPointerDown={handlePointerDown}
         onPointerMove={handlePointerMove}
         onPointerUp={handlePointerUp}
         onPointerCancel={handlePointerUp}
         onPointerLeave={handlePointerLeave}>
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          {theme === "light" ? (
            <radialGradient id="ocean-fill" cx="35%" cy="38%" r="75%">
              <stop offset="0%"  stopColor="#eef2f7" />
              <stop offset="55%" stopColor="#dbe2eb" />
              <stop offset="92%" stopColor="#c0cad8" />
              <stop offset="100%" stopColor="#b3bfd0" />
            </radialGradient>
          ) : (
            <radialGradient id="ocean-fill" cx="35%" cy="38%" r="75%">
              <stop offset="0%"  stopColor="#1f2937" />
              <stop offset="50%" stopColor="#111827" />
              <stop offset="92%" stopColor="#0a0f1a" />
              <stop offset="100%" stopColor="#060b14" />
            </radialGradient>
          )}
          <clipPath id="globe-clip">
            <circle cx={cx} cy={cy} r={R} />
          </clipPath>
        </defs>

        {theme === "dark" && (
          <g opacity={0.6}>
            {stars.map((s, i) => (
              <circle key={i} cx={s.x * size.w} cy={s.y * size.h} r={s.r} fill="#ffffff" opacity={s.o} />
            ))}
          </g>
        )}

        <circle cx={cx} cy={cy} r={R} fill="url(#ocean-fill)" />

        <g clipPath="url(#globe-clip)">
          {/* graticule */}
          <path d={pathGen(graticule) || ""}
                fill="none"
                stroke={theme === "light" ? "rgba(15,23,42,0.07)" : "rgba(96,165,250,0.05)"}
                strokeWidth={0.5} />
          {/* land */}
          {features?.land && (
            <path d={pathGen(features.land) || ""}
                  fill={theme === "light" ? "#475569" : "#2d3748"}
                  stroke={theme === "light" ? "rgba(15,23,42,0.45)" : "rgba(148,163,184,0.35)"}
                  strokeWidth={0.5}
                  strokeLinejoin="round" />
          )}
          {/* hovered country highlight */}
          {hoveredCountry && (
            <path d={pathGen(hoveredCountry) || ""}
                  fill="rgba(59,130,246,0.10)"
                  stroke="rgba(96,165,250,0.7)"
                  strokeWidth={0.9}
                  pointerEvents="none" />
          )}
          {/* country borders */}
          {features?.borders && (
            <path d={pathGen(features.borders) || ""}
                  fill="none"
                  stroke={theme === "light" ? "rgba(15,23,42,0.20)" : "rgba(148,163,184,0.18)"}
                  strokeWidth={0.35} />
          )}
        </g>

        {/* limb */}
        <circle cx={cx} cy={cy} r={R} fill="none"
                stroke={theme === "light" ? "rgba(15,23,42,0.18)" : "rgba(96,165,250,0.16)"}
                strokeWidth={1} />

        {/* worker pins */}
        {pinnedSlots.filter(p => p.visible).map(({ slot, color, coords, x, y }) => {
          const isHover    = hoveredSlotIndex === slot.slotIndex;
          const isSelected = selectedSlotIndex === slot.slotIndex;
          const isActive   = isHover || isSelected;

          const fill =
            color === "blue"  ? "#60a5fa" :
            color === "amber" ? "#fbbf24" :
            "#f87171";

          let magnetBoost = 0;
          if (cursorPos && !isDragging) {
            const dx = cursorPos.x - x;
            const dy = cursorPos.y - y;
            const d = Math.sqrt(dx*dx + dy*dy);
            if (d < 55) magnetBoost = (1 - d / 55) * 0.5;
          }
          const dotR  = (isActive ? 5 : 4) * (1 + magnetBoost);
          const ringR = (isActive ? 14 : 10) * (1 + magnetBoost);

          return (
            <g key={slot.slotIndex}
               data-pin={slot.slotIndex}
               style={{ cursor: "pointer" }}
               onPointerDown={(e) => e.stopPropagation()}
               onClick={(e) => { e.stopPropagation(); onSlotSelect(isSelected ? null : slot.slotIndex); }}
               onMouseEnter={() => onSlotHover(slot.slotIndex)}
               onMouseLeave={() => onSlotHover(null)}>
              {/* pulse ring for blue/on-call */}
              {color === "blue" && (
                <circle cx={x} cy={y} r={ringR * 1.4}
                        fill="none" stroke={fill}
                        strokeOpacity={0.35} strokeWidth={0.8}>
                  <animate attributeName="r" values={`${ringR};${ringR * 2};${ringR}`} dur="2.2s" repeatCount="indefinite" />
                  <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="2.2s" repeatCount="indefinite" />
                </circle>
              )}
              <circle cx={x} cy={y} r={ringR}
                      fill="none" stroke={fill}
                      strokeOpacity={isActive ? 0.85 : 0.45}
                      strokeWidth={isSelected ? 1.4 : 1} />
              <circle cx={x} cy={y} r={dotR}
                      fill={fill}
                      stroke={theme === "light" ? "#ffffff" : "#0d1117"}
                      strokeWidth={1} />
              {isActive && (
                <g transform={`translate(${x + ringR + 6}, ${y + 4})`} pointerEvents="none">
                  <text x={0} y={0}
                        fill={fill}
                        fontFamily="var(--font-geist-sans), Geist Mono, monospace"
                        fontSize={10}
                        fontWeight="600">
                    Worker {slot.slotIndex} · {coords?.city}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      {!features && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs text-[var(--text-3)] font-mono uppercase tracking-widest pointer-events-none">
          Loading world atlas…
        </div>
      )}

      {/* Country hover tooltip */}
      {hoveredCountry && cursorPos && !isDragging && hoveredSlotIndex == null && (() => {
        const name = hoveredCountry.properties?.name || "—";
        let tz = COUNTRY_TZ[name];
        if (!tz) {
          const cent = d3geo.geoCentroid(hoveredCountry);
          tz = cent ? approxTZFromLon(cent[0]) : "UTC";
        }
        const time = formatLocalTime(now, tz);
        const tipW = 170;
        let tx = cursorPos.x + 16;
        let ty = cursorPos.y + 16;
        if (tx + tipW > size.w - 8) tx = cursorPos.x - tipW - 16;
        if (ty + 80 > size.h - 8) ty = cursorPos.y - 80;
        return (
          <div className="absolute z-10 min-w-[140px] bg-[var(--bg-card)] border border-[var(--border-2)] rounded-xl px-3 py-2.5 pointer-events-none shadow-xl backdrop-blur-xl"
               style={{ left: tx, top: ty }}>
            <p className="font-mono text-base font-semibold text-[var(--text-1)] tabular-nums leading-tight">{time}</p>
            <p className="text-[11px] text-[var(--text-1)] mt-1">{name}</p>
            <p className="text-[10px] text-[var(--text-3)] mt-0.5 font-mono">{tz}</p>
          </div>
        );
      })()}

      {/* Floating worker card */}
      {(() => {
        const idx = hoveredSlotIndex ?? selectedSlotIndex;
        if (idx == null) return null;
        const p = pinnedSlots.find(x => x.slot.slotIndex === idx);
        if (!p || !p.visible) return null;
        const isPinned = selectedSlotIndex === idx && hoveredSlotIndex == null;

        const statusLabel =
          p.color === "blue"  ? "on call" :
          p.color === "amber" ? "idle" : "maintenance";

        const badgeClass =
          p.color === "blue"  ? "bg-blue-500/10 text-blue-400 border-blue-500/30" :
          p.color === "amber" ? "bg-amber-500/10 text-amber-400 border-amber-500/30" :
          "bg-red-500/10 text-red-400 border-red-500/30";

        const callDur = p.slot.inFlightCall ? formatCallDuration(p.slot.inFlightCall.durationMs) : null;
        const localTime = p.slot.campaign ? formatLocalTime(now, p.slot.campaign.timezone) : null;

        const cardW = 260;
        let tx = p.x + 22;
        let ty = p.y - 80;
        if (tx + cardW > size.w - 8) tx = p.x - cardW - 22;
        if (ty + 200 > size.h - 8) ty = Math.max(8, p.y - 200);
        if (ty < 8) ty = 8;

        return (
          <div className="absolute z-20 bg-[var(--bg-card)] border border-[var(--border-2)] rounded-2xl p-4 shadow-2xl backdrop-blur-xl"
               style={{ left: tx, top: ty, width: cardW, pointerEvents: isPinned ? "auto" : "none" }}>
            {isPinned && (
              <button
                onClick={(e) => { e.stopPropagation(); onSlotSelect(null); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute top-2 right-2 w-6 h-6 grid place-items-center rounded-md text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition"
                aria-label="Close">
                <X size={12} />
              </button>
            )}
            <div className={`flex items-center justify-between gap-2 mb-1 ${isPinned ? "pr-8" : ""}`}>
              <span className="text-sm font-semibold text-[var(--text-1)]">Worker {p.slot.slotIndex}</span>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono border ${badgeClass}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {statusLabel}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-2)] pb-2.5 mb-2.5 border-b border-[var(--border)]">
              <MapPin size={11} className="text-[var(--text-3)]" />
              {p.coords?.city}, {p.coords?.country}
              <span className="text-[var(--text-3)] ml-1">· {localTime}</span>
            </div>
            <div className="flex flex-col gap-2 text-[11px]">
              {p.slot.campaign && (
                <div className="grid grid-cols-[76px_1fr] gap-2 items-baseline">
                  <span className="text-[10px] text-[var(--text-3)]">Campaign</span>
                  <span className="text-[var(--text-1)]">{p.slot.campaign.name}</span>
                </div>
              )}
              {p.slot.campaign?.vapiAssistantName && (
                <div className="grid grid-cols-[76px_1fr] gap-2 items-baseline">
                  <span className="text-[10px] text-[var(--text-3)]">Agent</span>
                  <span className="text-[var(--text-1)] font-mono text-[11px]">{p.slot.campaign.vapiAssistantName}</span>
                </div>
              )}
              {p.slot.inFlightCall && (
                <div className="grid grid-cols-[76px_1fr] gap-2 items-baseline">
                  <span className="text-[10px] text-[var(--text-3)]">Call</span>
                  <span className="text-blue-400 font-mono inline-flex items-center gap-1.5">
                    <Phone size={10} />
                    {p.slot.inFlightCall.phoneE164} · {callDur}
                  </span>
                </div>
              )}
              {p.slot.notes && (
                <div className="grid grid-cols-[76px_1fr] gap-2 items-baseline">
                  <span className="text-[10px] text-[var(--text-3)]">Note</span>
                  <span className="text-[var(--text-1)]">{p.slot.notes}</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
