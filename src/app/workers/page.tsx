"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ArrowUpRight, CheckCircle2, Clock3, Globe2, Loader2,
  MapPin, Phone, PhoneCall, PhoneOff, Radio, Wrench,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────
// Workers landing — design doc §5.2 anonymous-slot polling view.
//
// Workers have NO pre-assigned geography. Their location is derived from the
// CAMPAIGN they currently lease, via Intl.DateTimeFormat on the campaign's
// `timezone` field. Free workers show only their slot number + status. The
// worldmap pins exclusively LEASED workers; free workers don't appear on it.
//
// Data source: GET /api/workers/state (Step 8) — server-side aggregation of
// vapi_sip_pool + campaigns_v2 + active calls_v2. Polled every 5 seconds.
// The local time on each worker card ticks every second via a separate clock.
//
// Replaced the prior `f6982e7 feat(workers): add world-clock dashboard landing`
// which used hardcoded city assignments for each slot (Vancouver/Toronto/
// London/Manila/Sydney). That violated the anonymous-slot principle locked in
// the 2026-05-15 design session.
// ─────────────────────────────────────────────────────────────────────────

// ── Types matching /api/workers/state response ───────────────────────────
interface InFlightCall {
  callId: string;
  vapiCallId: string | null;
  phoneE164: string | null;
  status: string;
  startedAt: string;
  durationMs: number;
}

interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  timezone: string;
  vapiAssistantName: string | null;
}

interface WorkerSlot {
  slotIndex: number;
  slotLabel: string;
  status: "free" | "leased" | "maintenance";
  sipUri: string;
  leasedAt: string | null;
  leasedDurationMs: number | null;
  campaign: CampaignInfo | null;
  inFlightCall: InFlightCall | null;
  notes: string | null;
}

interface WorkersStateResponse {
  fetchedAt: string;
  slots: WorkerSlot[];
}

// ── Timezone → map coords (for pinning leased workers on the worldmap) ──
// Reused from the prior workers page; same 17-city anchor set.
// If a leased campaign's timezone isn't in this map, the worker still shows
// in the table but no map pin appears for it.
interface MapCoord {
  x: number;
  y: number;
  label: string;
}

// Coords inherited from the prior f6982e7 workers landing — empirically tuned
// against /sl_070722_51460_26.jpg by the prior page author. Pins land in the
// correct region but the absolute latitude is approximate (off by ~3-5° at
// mid-northern latitudes). Operationally fine — the design doc §5.2 signal
// is "what countries are we calling into," which the region-level accuracy
// conveys. Pixel-perfect tuning is a Phase 2 polish task; attempted
// empirically during the Step 9 rewrite and reverted as not worth the iteration
// cost without live preview tooling.
const TIMEZONE_COORDS: Record<string, MapCoord> = {
  "America/Vancouver": { x: 23.5, y: 39, label: "Vancouver" },
  "America/Los_Angeles": { x: 23.8, y: 45, label: "Los Angeles" },
  "America/Denver": { x: 26, y: 44, label: "Denver" },
  "America/Chicago": { x: 28.5, y: 43.5, label: "Chicago" },
  "America/Toronto": { x: 29.5, y: 41, label: "Toronto" },
  "America/New_York": { x: 31.5, y: 42, label: "New York" },
  "America/Mexico_City": { x: 28.2, y: 52, label: "Mexico City" },
  "Europe/London": { x: 48.5, y: 37, label: "London" },
  "Europe/Paris": { x: 50.2, y: 40.5, label: "Paris" },
  "Europe/Berlin": { x: 51.5, y: 38, label: "Berlin" },
  "Europe/Madrid": { x: 49.2, y: 43, label: "Madrid" },
  "Europe/Athens": { x: 54, y: 44, label: "Athens" },
  "Asia/Dubai": { x: 61.5, y: 51, label: "Dubai" },
  "Asia/Singapore": { x: 74.5, y: 64, label: "Singapore" },
  "Asia/Manila": { x: 77.5, y: 58, label: "Manila" },
  "Asia/Tokyo": { x: 82.5, y: 48, label: "Tokyo" },
  "Australia/Sydney": { x: 82.5, y: 75, label: "Sydney" },
};

// ── Helpers ──────────────────────────────────────────────────────────────

function deriveCity(timezone: string): string {
  const known = TIMEZONE_COORDS[timezone];
  if (known) return known.label;
  // Fallback: last IANA segment, underscores → spaces.
  const segments = timezone.split("/");
  return segments[segments.length - 1].replace(/_/g, " ");
}

function deriveCoords(timezone: string): MapCoord | null {
  return TIMEZONE_COORDS[timezone] ?? null;
}

function formatTime(now: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
}

function formatUtcOffset(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    }).formatToParts(now);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // Normalize "GMT+10" → "UTC+10" for consistency with the design doc mockup.
    return offset.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

function formatLeasedDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatCallDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// ── Pin color logic per design doc §5.2 ──
//   blue   : leased AND a call is in flight on this worker
//   amber  : leased but idle (no in-flight call)
//   red    : maintenance (PATCH detach failed; operator-resolvable)
//   null   : free (no pin on the map)
type PinColor = "blue" | "amber" | "red";

function pinColorForSlot(slot: WorkerSlot): PinColor | null {
  if (slot.status === "maintenance") return "red";
  if (slot.status === "leased") return slot.inFlightCall ? "blue" : "amber";
  return null;
}

const PIN_STYLES: Record<PinColor, { dot: string; bg: string; border: string; text: string; pulse: boolean }> = {
  blue: {
    dot: "bg-sky-400",
    bg: "bg-sky-500/15",
    border: "border-sky-500/40",
    text: "text-sky-300",
    pulse: true,
  },
  amber: {
    dot: "bg-amber-400",
    bg: "bg-amber-500/15",
    border: "border-amber-500/40",
    text: "text-amber-300",
    pulse: false,
  },
  red: {
    dot: "bg-red-400",
    bg: "bg-red-500/15",
    border: "border-red-500/40",
    text: "text-red-300",
    pulse: false,
  },
};

// ── Live-clock hook (1s tick) — used for "local time at customer" display ──
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

// ── Pool-state polling (5s) per design doc §5.2 ──
function useWorkersState() {
  const [data, setData] = useState<WorkersStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workers/state", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as WorkersStateResponse;
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workers state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await load();
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [load]);

  return { data, loading, error, refresh: load };
}

// ── Worldmap component ──
function WorldMap({ slots, now }: { slots: WorkerSlot[]; now: Date }) {
  const [hovered, setHovered] = useState<WorkerSlot | null>(null);

  const pinnedSlots = useMemo(
    () =>
      slots
        .map((s) => ({ slot: s, color: pinColorForSlot(s), coords: s.campaign ? deriveCoords(s.campaign.timezone) : null }))
        .filter((p): p is { slot: WorkerSlot; color: PinColor; coords: MapCoord } => p.color !== null && p.coords !== null),
    [slots],
  );

  return (
    <div className="relative aspect-[16/9] min-h-[300px] overflow-hidden rounded-lg border border-[var(--border)] bg-[#0a1018]">
      <div
        className="absolute inset-0 bg-contain bg-center bg-no-repeat opacity-80 invert"
        style={{ backgroundImage: "url('/sl_070722_51460_26.jpg')" }}
        role="img"
        aria-label="World map with active worker locations"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(10,16,24,0.04),rgba(10,16,24,0.62))]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:36px_36px] mix-blend-screen" />

      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 py-2 backdrop-blur">
        <Globe2 size={15} className="text-emerald-300" />
        <span className="text-xs font-semibold text-white">Active Workers</span>
      </div>

      <div className="absolute right-4 top-4 rounded-md border border-white/10 bg-black/40 px-3 py-2 text-right backdrop-blur">
        {hovered && hovered.campaign ? (
          <>
            <p className="max-w-44 truncate text-xs font-semibold text-white">{hovered.slotLabel}</p>
            <p className="max-w-44 truncate text-[11px] text-slate-300">{hovered.campaign.name}</p>
            <p className="text-[11px] text-slate-400">
              {deriveCity(hovered.campaign.timezone)} · {formatUtcOffset(now, hovered.campaign.timezone)}
            </p>
            <p className="text-[11px] text-slate-300">{formatTime(now, hovered.campaign.timezone)}</p>
          </>
        ) : (
          <>
            <p className="text-xs font-semibold text-white">{pinnedSlots.length} pin{pinnedSlots.length === 1 ? "" : "s"}</p>
            <p className="text-[11px] text-slate-400">Hover a worker for details</p>
          </>
        )}
      </div>

      {pinnedSlots.map(({ slot, color, coords }) => {
        const styles = PIN_STYLES[color];
        return (
          <button
            key={slot.slotIndex}
            type="button"
            onMouseEnter={() => setHovered(slot)}
            onFocus={() => setHovered(slot)}
            onMouseLeave={() => setHovered(null)}
            onBlur={() => setHovered(null)}
            className="absolute -translate-x-1/2 -translate-y-1/2 outline-none"
            style={{ left: `${coords.x}%`, top: `${coords.y}%` }}
            aria-label={`${slot.slotLabel} pin`}
          >
            <div className={`relative flex h-8 w-8 items-center justify-center rounded-full border ${styles.border} ${styles.bg} shadow-lg shadow-black/30`}>
              <span className={`absolute h-8 w-8 rounded-full ${styles.dot} opacity-20 ${styles.pulse ? "animate-ping" : ""}`} />
              <span className={`relative h-2.5 w-2.5 rounded-full ${styles.dot}`} />
            </div>
            <div className="mt-1.5 min-w-24 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-center backdrop-blur">
              <p className="text-[10px] font-semibold text-white">{slot.slotLabel.replace("voizo-sip-pool-slot-", "Worker ")}</p>
              <p className="text-[10px] text-slate-300">{coords.label}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Worker table — anonymous rows for free; campaign+activity for leased ──
function WorkerTable({ slots, now }: { slots: WorkerSlot[]; now: Date }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]/60">
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Worker</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Calling</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Campaign</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Agent</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Activity</th>
            <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Status</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) => {
            const color = pinColorForSlot(slot);
            const styles = color ? PIN_STYLES[color] : null;
            const isLeased = slot.status === "leased";
            const city = slot.campaign ? deriveCity(slot.campaign.timezone) : null;
            const offset = slot.campaign ? formatUtcOffset(now, slot.campaign.timezone) : null;
            const localTime = slot.campaign ? formatTime(now, slot.campaign.timezone) : null;

            return (
              <tr key={slot.slotIndex} className="border-b border-[var(--border)] last:border-b-0">
                {/* Worker column */}
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-md ${
                      styles?.bg ?? "bg-[var(--bg-elevated)]"
                    }`}>
                      {slot.status === "free" ? (
                        <CheckCircle2 size={14} className="text-slate-400" />
                      ) : slot.status === "maintenance" ? (
                        <Wrench size={14} className="text-red-300" />
                      ) : slot.inFlightCall ? (
                        <PhoneCall size={14} className="text-sky-300" />
                      ) : (
                        <Radio size={14} className="text-amber-300" />
                      )}
                    </div>
                    <div>
                      <p className="font-semibold text-[var(--text-1)]">{slot.slotLabel.replace("voizo-sip-pool-slot-", "Worker ")}</p>
                      <p className="mt-0.5 text-[10px] text-[var(--text-3)]">{slot.sipUri}</p>
                    </div>
                  </div>
                </td>

                {/* Calling (city + offset + local time) */}
                <td className="px-4 py-3">
                  {isLeased && city ? (
                    <>
                      <p className="flex items-center gap-1 font-medium text-[var(--text-1)]">
                        <MapPin size={11} className="text-[var(--text-3)]" />
                        {city}
                        {offset && <span className="ml-1 text-[10px] text-[var(--text-3)]">· {offset}</span>}
                      </p>
                      {localTime && <p className="mt-0.5 text-[10px] text-[var(--text-3)]">Local: {localTime}</p>}
                    </>
                  ) : (
                    <span className="text-[var(--text-3)]">—</span>
                  )}
                </td>

                {/* Campaign */}
                <td className="px-4 py-3">
                  {slot.campaign ? (
                    <Link
                      href={`/campaigns/v2/${slot.campaign.id}`}
                      className="font-medium text-[var(--text-1)] hover:text-blue-400 transition-colors"
                    >
                      <span className="line-clamp-1">{slot.campaign.name}</span>
                      <p className="mt-0.5 text-[10px] capitalize text-[var(--text-3)]">{slot.campaign.status}</p>
                    </Link>
                  ) : (
                    <span className="text-[var(--text-3)]">Unassigned</span>
                  )}
                </td>

                {/* Agent */}
                <td className="px-4 py-3 text-[var(--text-2)]">{slot.campaign?.vapiAssistantName ?? "—"}</td>

                {/* Activity */}
                <td className="px-4 py-3 text-[var(--text-2)]">
                  {slot.inFlightCall ? (
                    <>
                      <p className="flex items-center gap-1.5 text-sky-300">
                        <Phone size={11} />
                        On call
                        {slot.inFlightCall.phoneE164 && <span className="text-[var(--text-2)]">· {slot.inFlightCall.phoneE164}</span>}
                        <span className="text-[10px] tabular-nums text-[var(--text-3)]">{formatCallDuration(slot.inFlightCall.durationMs)}</span>
                      </p>
                    </>
                  ) : isLeased ? (
                    <p className="flex items-center gap-1.5 text-[var(--text-2)]">
                      <PhoneOff size={11} className="text-[var(--text-3)]" />
                      Idle
                      <span className="text-[10px] text-[var(--text-3)]">· leased {formatLeasedDuration(slot.leasedDurationMs)}</span>
                    </p>
                  ) : slot.status === "maintenance" ? (
                    <p className="flex items-center gap-1.5 text-red-300">
                      <Wrench size={11} />
                      Maintenance
                    </p>
                  ) : (
                    <span className="text-[var(--text-3)]">Released</span>
                  )}
                  {slot.notes && slot.status === "maintenance" && (
                    <p className="mt-0.5 max-w-52 truncate text-[10px] text-amber-300">{slot.notes}</p>
                  )}
                </td>

                {/* Status badge */}
                <td className="px-4 py-3 text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize ${
                      styles
                        ? `${styles.bg} ${styles.border} ${styles.text}`
                        : "bg-[var(--bg-elevated)] border-[var(--border)] text-[var(--text-3)]"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${styles?.dot ?? "bg-slate-400"}`} />
                    {slot.status === "leased" && slot.inFlightCall ? "On call" : slot.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function WorkersPage() {
  const now = useNow();
  const { data, loading, error } = useWorkersState();

  const slots = data?.slots ?? [];

  const activeCalls = useMemo(() => slots.filter((s) => s.inFlightCall).length, [slots]);
  const leasedCount = useMemo(() => slots.filter((s) => s.status === "leased").length, [slots]);
  const freeCount = useMemo(() => slots.filter((s) => s.status === "free").length, [slots]);
  const maintenanceCount = useMemo(() => slots.filter((s) => s.status === "maintenance").length, [slots]);

  return (
    <div className="w-full p-4 sm:p-6">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-1)]">Workers</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-3)]">
            <span className="inline-flex items-center gap-1.5">
              <PhoneCall size={12} className="text-sky-300" />
              Active calls: <span className="font-semibold text-[var(--text-1)]">{activeCalls}</span> / {slots.length || 5}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Radio size={12} className="text-amber-300" />
              {leasedCount} leased
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={12} className="text-slate-400" />
              {freeCount} free
            </span>
            {maintenanceCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Wrench size={12} className="text-red-300" />
                {maintenanceCount} maintenance
              </span>
            )}
            {loading && !data && (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                loading
              </span>
            )}
            {error && (
              <span className="inline-flex items-center gap-1.5 text-amber-300">
                <AlertCircle size={12} />
                {error}
              </span>
            )}
            {data && (
              <span className="inline-flex items-center gap-1.5 text-[var(--text-3)]">
                <Clock3 size={12} />
                Synced {formatTime(now, "UTC")} UTC
              </span>
            )}
          </div>
        </div>
        <Link
          href="/campaigns"
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2 text-sm font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]"
        >
          Campaigns
          <ArrowUpRight size={14} />
        </Link>
      </div>

      <WorldMap slots={slots} now={now} />

      <section className="mt-4 overflow-x-auto">
        <WorkerTable slots={slots} now={now} />
      </section>
    </div>
  );
}
