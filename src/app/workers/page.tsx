"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, ArrowUpRight, CheckCircle2, Clock3, Globe2, Loader2,
  MapPin, Radio, Wrench,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

type WorkerStatus = "busy" | "free" | "maintenance";

interface WorkerLocation {
  id: string;
  slot: number;
  city: string;
  country: string;
  timezone: string;
  x: number;
  y: number;
}

interface PoolSlotRow {
  id: string;
  slot_index: number;
  status: string | null;
  current_assistant_id: string | null;
  current_campaign_id: string | null;
  leased_at: string | null;
  released_at: string | null;
  notes: string | null;
}

interface CampaignRow {
  id: string;
  name: string | null;
  status: string | null;
  vapi_assistant_name: string | null;
  timezone: string | null;
  start_at: string | null;
}

interface MapAnchor {
  label: string;
  zone: string;
  x: number;
  y: number;
}

interface CampaignMapPoint extends MapAnchor {
  campaigns: CampaignRow[];
}

interface Worker extends WorkerLocation {
  status: WorkerStatus;
  slotStatus?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  campaignStatus?: string | null;
  agentName?: string | null;
  leasedAt?: string | null;
  releasedAt?: string | null;
  note?: string | null;
}

const workerLocations: WorkerLocation[] = [
  { id: "Worker 01", slot: 1, city: "Vancouver", country: "Canada", timezone: "America/Vancouver", x: 23.5, y: 39 },
  { id: "Worker 02", slot: 2, city: "Toronto", country: "Canada", timezone: "America/Toronto", x: 29.5, y: 41 },
  { id: "Worker 03", slot: 3, city: "London", country: "United Kingdom", timezone: "Europe/London", x: 48.5, y: 37 },
  { id: "Worker 04", slot: 4, city: "Manila", country: "Philippines", timezone: "Asia/Manila", x: 77.5, y: 58 },
  { id: "Worker 05", slot: 5, city: "Sydney", country: "Australia", timezone: "Australia/Sydney", x: 82.5, y: 75 },
];

const timeZones: MapAnchor[] = [
  { label: "Vancouver", zone: "America/Vancouver", x: 23.5, y: 39 },
  { label: "Los Angeles", zone: "America/Los_Angeles", x: 23.8, y: 45 },
  { label: "Denver", zone: "America/Denver", x: 26, y: 44 },
  { label: "Chicago", zone: "America/Chicago", x: 28.5, y: 43.5 },
  { label: "Toronto", zone: "America/Toronto", x: 29.5, y: 41 },
  { label: "New York", zone: "America/New_York", x: 31.5, y: 42 },
  { label: "Mexico City", zone: "America/Mexico_City", x: 28.2, y: 52 },
  { label: "London", zone: "Europe/London", x: 48.5, y: 37 },
  { label: "Paris", zone: "Europe/Paris", x: 50.2, y: 40.5 },
  { label: "Berlin", zone: "Europe/Berlin", x: 51.5, y: 38 },
  { label: "Madrid", zone: "Europe/Madrid", x: 49.2, y: 43 },
  { label: "Athens", zone: "Europe/Athens", x: 54, y: 44 },
  { label: "Dubai", zone: "Asia/Dubai", x: 61.5, y: 51 },
  { label: "Singapore", zone: "Asia/Singapore", x: 74.5, y: 64 },
  { label: "Manila", zone: "Asia/Manila", x: 77.5, y: 58 },
  { label: "Tokyo", zone: "Asia/Tokyo", x: 82.5, y: 48 },
  { label: "Sydney", zone: "Australia/Sydney", x: 82.5, y: 75 },
];

const featuredTimeZones = timeZones.filter((timeZone) => (
  timeZone.zone === "America/Vancouver" ||
  timeZone.zone === "America/Toronto" ||
  timeZone.zone === "Europe/London" ||
  timeZone.zone === "Asia/Manila" ||
  timeZone.zone === "Australia/Sydney"
));

const timezoneByName = new Map(timeZones.map((timeZone) => [timeZone.zone, timeZone]));
const workerTimezones = new Set(workerLocations.map((worker) => worker.timezone));

function statusStyles(status: WorkerStatus) {
  if (status === "busy") return {
    label: "Busy",
    text: "text-emerald-300",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
    dot: "bg-emerald-400",
    Icon: Radio,
  };
  if (status === "maintenance") return {
    label: "Maint",
    text: "text-amber-300",
    bg: "bg-amber-500/10",
    border: "border-amber-500/20",
    dot: "bg-amber-400",
    Icon: Wrench,
  };
  return {
    label: "Free",
    text: "text-sky-300",
    bg: "bg-sky-500/10",
    border: "border-sky-500/20",
    dot: "bg-sky-400",
    Icon: CheckCircle2,
  };
}

function useNow() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return now;
}

function formatTime(now: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
}

function formatDay(now: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);
}

function formatElapsed(iso?: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function deriveStatus(slot?: PoolSlotRow): WorkerStatus {
  const status = slot?.status?.toLowerCase() ?? "";
  if (status.includes("maint") || status.includes("error")) return "maintenance";
  if (slot?.current_campaign_id || slot?.current_assistant_id || status === "busy" || status === "leased") return "busy";
  return "free";
}

function composeWorkers(slots: PoolSlotRow[], campaigns: CampaignRow[]): Worker[] {
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const slotByIndex = new Map(slots.map((slot) => [slot.slot_index, slot]));

  return workerLocations.map((location) => {
    const slot = slotByIndex.get(location.slot);
    const campaign = slot?.current_campaign_id ? campaignById.get(slot.current_campaign_id) : undefined;

    return {
      ...location,
      status: deriveStatus(slot),
      slotStatus: slot?.status,
      campaignId: slot?.current_campaign_id,
      campaignName: campaign?.name ?? null,
      campaignStatus: campaign?.status ?? null,
      agentName: campaign?.vapi_assistant_name ?? null,
      leasedAt: slot?.leased_at,
      releasedAt: slot?.released_at,
      note: slot?.notes,
    };
  });
}

function composeCampaignMapPoints(campaigns: CampaignRow[]): CampaignMapPoint[] {
  const byZone = new Map<string, CampaignRow[]>();

  for (const campaign of campaigns) {
    if (!campaign.timezone || !timezoneByName.has(campaign.timezone)) continue;
    if (!byZone.has(campaign.timezone)) byZone.set(campaign.timezone, []);
    byZone.get(campaign.timezone)?.push(campaign);
  }

  return Array.from(byZone.entries()).map(([zone, rows]) => {
    const anchor = timezoneByName.get(zone)!;
    return { ...anchor, campaigns: rows };
  });
}

type HoverTarget = MapAnchor | CampaignMapPoint | Worker;

function hoverTitle(target: HoverTarget) {
  if ("campaigns" in target) {
    const first = target.campaigns[0];
    return target.campaigns.length === 1
      ? first.name ?? `Campaign ${first.id.slice(0, 8)}`
      : `${target.campaigns.length} campaigns`;
  }
  if ("city" in target) return target.city;
  return target.label;
}

function hoverZone(target: HoverTarget) {
  if ("timezone" in target) return target.timezone;
  return target.zone;
}

function hoverDetail(target: HoverTarget) {
  if ("campaigns" in target) return target.label;
  if ("city" in target) return target.campaignName ?? target.country;
  return "Local time";
}

function isWorkerTimezone(zone: string) {
  return workerTimezones.has(zone);
}

function WorldMap({
  workers,
  campaigns,
  now,
}: {
  workers: Worker[];
  campaigns: CampaignRow[];
  now: Date;
}) {
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const campaignPoints = useMemo(() => composeCampaignMapPoints(campaigns), [campaigns]);

  return (
    <div className="relative aspect-[16/9] min-h-[300px] overflow-hidden rounded-lg border border-[var(--border)] bg-[#0a1018]">
      <div
        className="absolute inset-0 bg-contain bg-center bg-no-repeat opacity-80 invert"
        style={{ backgroundImage: "url('/sl_070722_51460_26.jpg')" }}
        role="img"
        aria-label="World map with worker locations"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(10,16,24,0.04),rgba(10,16,24,0.62))]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:36px_36px] mix-blend-screen" />

      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 py-2 backdrop-blur">
        <Globe2 size={15} className="text-emerald-300" />
        <span className="text-xs font-semibold text-white">Worker World Clock</span>
      </div>

      <div className="absolute right-4 top-4 rounded-md border border-white/10 bg-black/40 px-3 py-2 text-right backdrop-blur">
        {hovered ? (
          <>
            <p className="max-w-44 truncate text-xs font-semibold text-white">{hoverTitle(hovered)}</p>
            <p className="text-[11px] text-slate-400">{hoverDetail(hovered)}</p>
            <p className="text-[11px] text-slate-300">{formatTime(now, hoverZone(hovered))}</p>
          </>
        ) : (
          <>
            <p className="text-xs font-semibold text-white">Hover the map</p>
            <p className="text-[11px] text-slate-400">Known regions show local time</p>
          </>
        )}
      </div>

      {timeZones.map((timeZone) => (
        <button
          key={timeZone.zone}
          type="button"
          aria-label={`${timeZone.label} time`}
          onMouseEnter={() => setHovered(timeZone)}
          onFocus={() => setHovered(timeZone)}
          onMouseLeave={() => setHovered(null)}
          onBlur={() => setHovered(null)}
          className="group absolute h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none"
          style={{ left: `${timeZone.x}%`, top: `${timeZone.y}%` }}
        >
          {!isWorkerTimezone(timeZone.zone) && (
            <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/25 bg-white/25 shadow-lg shadow-black/30 transition-all group-hover:h-3.5 group-hover:w-3.5 group-hover:bg-sky-300/80 group-focus:h-3.5 group-focus:w-3.5 group-focus:bg-sky-300/80" />
          )}
        </button>
      ))}

      {campaignPoints.map((point) => (
        <button
          key={point.zone}
          type="button"
          onMouseEnter={() => setHovered(point)}
          onFocus={() => setHovered(point)}
          onMouseLeave={() => setHovered(null)}
          onBlur={() => setHovered(null)}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full outline-none"
          style={{ left: `${point.x + 1.4}%`, top: `${point.y + 2}%` }}
          title={`${point.campaigns.length} campaign${point.campaigns.length === 1 ? "" : "s"} in ${point.label}`}
        >
          <span className="relative flex h-6 min-w-6 items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 px-1 text-[10px] font-bold text-amber-100 shadow-lg shadow-black/30">
            {point.campaigns.length}
          </span>
        </button>
      ))}

      {workers.map((worker) => {
        const styles = statusStyles(worker.status);
        return (
          <button
            key={worker.id}
            type="button"
            onMouseEnter={() => setHovered(worker)}
            onFocus={() => setHovered(worker)}
            onMouseLeave={() => setHovered(null)}
            onBlur={() => setHovered(null)}
            className="absolute -translate-x-1/2 -translate-y-1/2 outline-none"
            style={{ left: `${worker.x}%`, top: `${worker.y}%` }}
          >
            <div className={`relative flex h-8 w-8 items-center justify-center rounded-full border ${styles.border} ${styles.bg} shadow-lg shadow-black/30`}>
              <span className={`absolute h-8 w-8 rounded-full ${styles.dot} opacity-20 ${worker.status === "busy" ? "animate-ping" : ""}`} />
              <span className={`relative h-2.5 w-2.5 rounded-full ${styles.dot}`} />
            </div>
            <div className="mt-1.5 min-w-24 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-center backdrop-blur">
              <p className="text-[10px] font-semibold text-white">{worker.city}</p>
              <p className="text-[10px] text-slate-300">{formatTime(now, worker.timezone)}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function WorkerTable({ workers, now }: { workers: Worker[]; now: Date }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]/60">
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Worker</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Local Time</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Campaign</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Agent</th>
            <th className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Activity</th>
            <th className="px-4 py-3 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Status</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => {
            const styles = statusStyles(worker.status);
            const Icon = styles.Icon;
            const campaignLabel = worker.campaignName ?? (worker.campaignId ? `Campaign ${worker.campaignId.slice(0, 8)}` : "Unassigned");

            return (
              <tr key={worker.id} className="border-b border-[var(--border)] last:border-b-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-md ${styles.bg}`}>
                      <Icon size={14} className={styles.text} />
                    </div>
                    <div>
                      <p className="font-semibold text-[var(--text-1)]">{worker.id}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-[var(--text-3)]">
                        <MapPin size={10} />
                        {worker.city}, {worker.country}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <p className="font-semibold text-[var(--text-1)]">{formatTime(now, worker.timezone)}</p>
                  <p className="mt-0.5 text-[10px] text-[var(--text-3)]">{formatDay(now, worker.timezone)}</p>
                </td>
                <td className="px-4 py-3">
                  <p className={worker.campaignName || worker.campaignId ? "font-medium text-[var(--text-1)]" : "text-[var(--text-3)]"}>
                    {campaignLabel}
                  </p>
                  {worker.campaignStatus && <p className="mt-0.5 text-[10px] capitalize text-[var(--text-3)]">{worker.campaignStatus}</p>}
                </td>
                <td className="px-4 py-3 text-[var(--text-2)]">{worker.agentName ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--text-2)]">
                  {worker.status === "busy" ? `Leased ${formatElapsed(worker.leasedAt)}` : `Released ${formatElapsed(worker.releasedAt)}`}
                  {worker.note && <p className="mt-0.5 max-w-52 truncate text-[10px] text-amber-300">{worker.note}</p>}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles.bg} ${styles.border} ${styles.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
                    {styles.label}
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

export default function WorkersPage() {
  const now = useNow();
  const [workers, setWorkers] = useState<Worker[]>(() => composeWorkers([], []));
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkers() {
      setLoading(true);
      setLoadError(null);

      try {
        const { data: slots, error: slotError } = await supabase
          .from("vapi_sip_pool")
          .select("id, slot_index, status, current_assistant_id, current_campaign_id, leased_at, released_at, notes")
          .order("slot_index", { ascending: true });

        if (slotError) throw slotError;

        const linkedCampaignIds = Array.from(
          new Set((slots ?? []).map((slot) => slot.current_campaign_id).filter(Boolean) as string[]),
        );

        const { data: visibleCampaigns, error: campaignsError } = await supabase
          .from("campaigns_v2")
          .select("id, name, status, vapi_assistant_name, timezone, start_at")
          .neq("status", "archived")
          .order("created_at", { ascending: false })
          .limit(30);
        if (campaignsError) throw campaignsError;

        let campaigns = visibleCampaigns ?? [];
        const missingLinkedIds = linkedCampaignIds.filter((id) => !campaigns.some((campaign) => campaign.id === id));
        if (missingLinkedIds.length > 0) {
          const { data, error } = await supabase
            .from("campaigns_v2")
            .select("id, name, status, vapi_assistant_name, timezone, start_at")
            .in("id", missingLinkedIds);
          if (error) throw error;
          campaigns = [...campaigns, ...(data ?? [])];
        }

        if (!cancelled) {
          setCampaigns(campaigns);
          setWorkers(composeWorkers((slots ?? []) as PoolSlotRow[], campaigns));
        }
      } catch (error) {
        console.error("Failed to load worker pool:", error);
        if (!cancelled) {
          setCampaigns([]);
          setWorkers(composeWorkers([], []));
          setLoadError("Pool data unavailable");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadWorkers();
    const id = window.setInterval(loadWorkers, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const counts = useMemo(() => ({
    busy: workers.filter((worker) => worker.status === "busy").length,
    free: workers.filter((worker) => worker.status === "free").length,
    maintenance: workers.filter((worker) => worker.status === "maintenance").length,
  }), [workers]);

  return (
    <div className="w-full p-4 sm:p-6">
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-1)]">Workers</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-3)]">
            <span className="inline-flex items-center gap-1.5"><Radio size={12} className="text-emerald-300" /> {counts.busy}/5 busy</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={12} className="text-sky-300" /> {counts.free} free</span>
            <span className="inline-flex items-center gap-1.5"><Wrench size={12} className="text-amber-300" /> {counts.maintenance} maintenance</span>
            <span className="inline-flex items-center gap-1.5"><Clock3 size={12} /> Manila {formatTime(now, "Asia/Manila")}</span>
            {loading && <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> syncing</span>}
            {loadError && <span className="inline-flex items-center gap-1.5 text-amber-300"><AlertCircle size={12} /> {loadError}</span>}
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.55fr)]">
        <WorldMap workers={workers} campaigns={campaigns} now={now} />

        <aside className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-1)]">World Time</h2>
            <Clock3 size={15} className="text-[var(--text-3)]" />
          </div>
          <div className="space-y-1.5">
            {featuredTimeZones.map((timeZone) => (
              <div key={timeZone.zone} className="flex items-center justify-between rounded-md bg-[var(--bg-elevated)] px-3 py-2">
                <div>
                  <p className="text-xs font-medium text-[var(--text-1)]">{timeZone.label}</p>
                  <p className="mt-0.5 text-[10px] text-[var(--text-3)]">{formatDay(now, timeZone.zone)}</p>
                </div>
                <p className="text-sm font-semibold text-[var(--text-1)]">{formatTime(now, timeZone.zone)}</p>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <section className="mt-4 overflow-x-auto">
        <WorkerTable workers={workers} now={now} />
      </section>
    </div>
  );
}
