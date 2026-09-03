"use client";

// Campaign Performance table (Val's endgame mockup, Slice C). Has its OWN date range + status chips,
// INDEPENDENT of the global filter bar above. Sort by Newest/Call Attempts/Reached/SMS (default
// Newest). Each row is the SHARED CampaignRow (the same camp-row as Today's campaigns): chips
// (country/players/date) + a derived status pill (incl. "Ended") + run window + three compact
// metric cells (Attempts/Reached/SMS, campaign-LIFETIME). Expands to the reused CampaignExpand
// (records + CSV/Audio/Transcripts); a "trailing" link opens the /campaigns/v2/[id] detail page.
// Data: /api/dashboard/campaigns?from=&to=.

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSnapshot, saveSnapshot } from "@/lib/sessionSnapshot";
import Link from "next/link";
import { ArrowRight, Download, Eye, EyeOff, Search, X } from "lucide-react";
import { summarizeRollupWindow, deriveRecordStatus, type TodayPerfDay, type CallRollupRow, type CampaignMoveRow, type SmsRollupRow, type PerfRow } from "@/lib/dashboardAnalytics";
import { MAX_CAMPAIGNS } from "@/lib/rangedRecords";
import { formatCampaign, brandLabel } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { triggerDownload } from "@/lib/download";
import PromptModal from "./PromptModal";
import Hint from "@/components/Hint";
import RangeCalendar from "./RangeCalendar";
import Pagination from "@/components/Pagination";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import { SortControl, type SortKey } from "./SortControl";
import { useExpandSlices } from "./useExpandSlices";
import { useBaseAgentNames } from "./useBaseAgentNames";
import { CampaignRowsSkeleton } from "./loadingSkeletons";
import { DISPO_LABEL } from "./recordsDisplay";
import WidgetCard from "./WidgetCard";
import CampaignRow, { CAMPAIGN_ROW_GRID, type CampaignRowData, type DisplayStatus, STATUS_META } from "./CampaignRow";
// The summary reuses the SAME cards + click-to-drill drawer as Global
// Performance (Jasiel 2026-08-07: "Val would want that same mechanism").
import PerformanceCards from "./PerformanceCards";
import RangedRecordsDrawer, { totalFilter, rowFilter, type DrawerFilter } from "./RangedRecordsDrawer";
import type { Filters as GlobalFilters } from "./GlobalPerformance";
import {
  agentKeyOf, anyCampaignFilterActive, brandKeyOf, matchesCampaignFilters, matchesCampaignName, scriptKeyOf,
  classifyQuery, NO_CAMPAIGN_FILTERS, NO_SCRIPT, type CampaignFilterState,
} from "./campaignFilters";
import { buildCampaignPerfCsv } from "./campaignPerfCsv";
// Grouping (Jasiel 2026-09-02, from the dashboard mockup): runs fold under their family,
// country, brand, voice agent or script. A family is the recurring parent, the same key the
// campaign picker groups by. Children under an open group are capped the way the picker is.
import { groupCampaignRows, sortGroups, runOrdinals, playOf, GROUP_FACETS, type GroupFacet, type GroupLabels } from "./campaignGrouping";
import { visibleChildren, type GroupableOption } from "@/lib/campaignGroups";
// The same picker Global Performance uses, now inside this section too (mockup's "All campaigns (N)").
import CampaignPicker from "./CampaignPicker";
import { campaignGroupHeaderLabels, campaignRunLabel } from "@/lib/campaignDisplay";

interface Row {
  id: string;
  name: string;
  country: string;
  cioWorkspace: string | null; // brand (VOZ-216)
  displayStatus: DisplayStatus;
  scheduleType: "fixed" | "recurring";
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  // Optional: session snapshots saved before 2026-08-07 predate these fields.
  scriptId?: string | null;
  scriptName?: string | null;
  segmentId?: string | null;
  parentCampaignId?: string | null; // the family (recurring parent); absent pre-2026-09-02
  calls: number;
  connected: number;
  terminal: number;
  successful: number;
  connectRate: number | null;
  successRate: number | null;
  players: number; // campaign roster size (lifetime)
  reach: number; // human-only connects in window
  smsSent: number; // texts dispatched for this campaign
  startAt: string | null;
  endAt: string | null;
  lastCallAt: string | null;
  perf: TodayPerfDay; // per-campaign LIFETIME breakdown for the camp-row columns
}
interface Resp {
  from: string;
  to: string;
  rows: Row[];
  /** Day-grain rollup rows (2026-08-07) — the summary block + mass export sum
   *  these client-side per the active filters. Optional: pre-deploy snapshots.
   *  `moves` carries the transcript reclassifications at the same (campaign, day)
   *  grain: without it the summary block would read the LEAN numbers while the
   *  rows above it read the corrected ones. Optional for the same reason. */
  rollup?: { calls: CallRollupRow[]; sms: SmsRollupRow[]; moves?: CampaignMoveRow[] };
}

/** One phone-lookup match from /api/dashboard/campaigns/phone-lookup. */
interface PhoneMatch {
  numberId: string;
  campaignId: string;
  phone: string;
  displayName: string | null;
  outcome: string | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  smsSent: boolean;
}
interface PhoneLookup {
  query: string;
  truncated: boolean;
  matches: PhoneMatch[];
}

const STATUS_ORDER: DisplayStatus[] = ["running", "paused", "finished"];

const PAGE_SIZE = 5; // rows per page (Jasiel 2026-07-01: 5 → less scrolling, paginate the rest)

// The summary block's cards are transcript-classified (the move map), but its drawer
// is /api/dashboard/records, which fetches WITHOUT transcripts and classifies lean —
// and the lean classifier can never emit silent_pickup at all (deriveAttemptTag gates
// that branch on useTranscript). So drilling "Silent pickup 601" would open an empty
// list under a non-zero count. Show the honest number, refuse the click, say why.
// The per-ROW expand is unaffected: it drills through
// /api/dashboard/campaigns/[id]/records, which IS transcript-classified.
// Removing this needs the ranged drawer to carry transcripts — a separate ticket,
// because that route defaults to 30d with a selectable lifetime preset and is shared
// with the ranged Global Performance cards.
const summaryNoDrillHint = (row: PerfRow): string | undefined =>
  row.key === "silent_pickup"
    ? "No drill-down yet: these are calls where nobody ever spoke, and the records drawer behind this section reads call data without transcripts, so it cannot list them. The count is correct. Open a single campaign's row to see them."
    : undefined;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function runWindow(r: Row): string {
  const start = fmtShort(r.startAt);
  if (!start) return "—";
  if (r.displayStatus === "running" || r.displayStatus === "paused") return `${start} → ongoing`;
  return `${start} → ${fmtShort(r.endAt ?? r.lastCallAt) ?? "—"}`;
}

const DAY_MS = 86_400_000;
// Parse a YYYY-MM-DD picker value into a UTC ms bound. endOfDay pushes to 23:59:59.999
// so the To date is inclusive (mirrors the API's parseDay). Invalid/empty → null (no bound).
function parseDayMs(value: string, endOfDay: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return endOfDay ? base + DAY_MS - 1 : base;
}

// Does this campaign have call activity that intersects the picked [from, to] window?
// Row metrics are LIFETIME (server no longer windows them); the picker only filters WHICH
// campaigns are listed. We use the campaign's activity span — run-window start through its
// last-call (or end_at) — and keep the row only if that span overlaps the picked range.
// Campaigns with NO call activity (no lastCallAt) and no usable window are dropped when a
// filter is set. fromMs null = open lower bound; toMs null = open upper bound.
function activeInRange(r: Row, fromMs: number | null, toMs: number | null): boolean {
  if (fromMs === null && toMs === null) return true; // no filter → show all
  const startMs = r.startAt ? Date.parse(r.startAt) : NaN;
  const lastMs = r.lastCallAt ? Date.parse(r.lastCallAt) : NaN;
  const endMs = r.endAt ? Date.parse(r.endAt) : NaN;
  // Activity span end = last call ever, else campaign end, else its start (a point).
  const spanEnd = Number.isFinite(lastMs) ? lastMs : Number.isFinite(endMs) ? endMs : startMs;
  const spanStart = Number.isFinite(startMs) ? startMs : spanEnd;
  // Drop campaigns with no usable activity signal at all once a filter is active.
  if (!Number.isFinite(spanStart) && !Number.isFinite(spanEnd)) return false;
  const lo = fromMs ?? Number.NEGATIVE_INFINITY;
  const hi = toMs ?? Number.POSITIVE_INFINITY;
  // Overlap test: [spanStart, spanEnd] intersects [lo, hi].
  return spanStart <= hi && spanEnd >= lo;
}

function sortValue(r: Row, key: SortKey): number {
  if (key === "calls") return r.perf.callAttempts.total; // "Call Attempts" column
  if (key === "reached") return r.perf.reached.total;
  if (key === "sms") return r.perf.sms.total;
  if (key === "newest") {
    // Newest first (desc): run-window start as ms. No created_at in the payload,
    // so startAt is the truest available recency proxy. Null/invalid → sort last.
    const t = r.startAt ? Date.parse(r.startAt) : NaN;
    return Number.isFinite(t) ? t : -1;
  }
  return r.perf.callAttempts.total; // fallback (e.g. a stale "connect"/"success" key) → by attempts
}

export default function CampaignTable() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<DisplayStatus>>(new Set());
  const [sort, setSort] = useState<SortKey>("newest");
  // Expand + per-row slice state (straight-to-records, Val's mockup) — shared hook.
  const { expanded, slices, toggleExpand, pickMetric, clearSlice } = useExpandSlices();
  const [promptFor, setPromptFor] = useState<{ id: string; title: string } | null>(null);
  const [page, setPage] = useState(1);
  // Section filters (Val 2026-08-07): country / brand / agent / script + player-phone lookup.
  const [filters, setFilters] = useState<CampaignFilterState>(NO_CAMPAIGN_FILTERS);
  // ONE search box (mockup, 2026-09-03): a campaign name, a player's number, or a player's
  // name. `phone` keeps its name for the lookup plumbing below; classifyQuery decides what
  // the text is asking for. The two boxes it replaced were "Campaign name…" and "Player number…".
  const [phone, setPhone] = useState("");
  // The section's own campaign picker (mockup's "All campaigns (N)"): ticked RUN ids; empty = all.
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  // Family chips: the PLAY a family runs (REACTIVATION, RND REG YESTERDAY, ...); "" = all.
  const [play, setPlay] = useState("");
  const [phoneRes, setPhoneRes] = useState<PhoneLookup | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneLoading, setPhoneLoading] = useState(false);
  // The section summary ("All campaigns" band) is ALWAYS visible since 2026-09-03 (mockup);
  // the 2026-08-07 hide/show toggle and its "dashboard.campaigns.showSummary" snapshot are gone.
  // Group by (Jasiel 2026-09-02). Family by default: in the default window every row is a
  // daily child of one of a handful of recurring parents. Remembered like the rest.
  const [groupBy, setGroupBy] = useState<GroupFacet>(() => loadSnapshot<GroupFacet>("dashboard.campaigns.groupBy") ?? "family");
  // Which groups are open, and which of those the operator asked to see in full. A group opens
  // capped at CHILD_PAGE_SIZE (the picker's rule); collapsing it forgets the show-all.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [showAllIn, setShowAllIn] = useState<Set<string>>(new Set());
  // Family summaries (2026-09-02): the same three cards as the section summary, summed over ONE
  // open family's runs. Off by default, as the mockup shipped them: the family header already
  // carries the three totals, and a page of card blocks under every family was measured at 55%
  // of the section restating its own rows. Remembered like the rest.
  const [showFamilySummaries, setShowFamilySummaries] = useState<boolean>(() => loadSnapshot<boolean>("dashboard.campaigns.showFamilySummaries") ?? false);
  const toggleFamilySummaries = () => setShowFamilySummaries((prev) => { const next = !prev; saveSnapshot("dashboard.campaigns.showFamilySummaries", next); return next; });
  // When a FAMILY card opened the drawer, the drawer lists that family's runs only. null = the
  // section summary opened it, scoped to everything listed.
  const [drawerFamilyIds, setDrawerFamilyIds] = useState<string[] | null>(null);
  const changeGroupBy = (g: GroupFacet) => {
    setGroupBy(g); setPage(1); setOpenGroups(new Set()); setShowAllIn(new Set());
    saveSnapshot("dashboard.campaigns.groupBy", g);
  };
  const toggleGroup = (key: string) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(key)) { next.delete(key); setShowAllIn((s) => { const t = new Set(s); t.delete(key); return t; }); }
    else next.add(key);
    return next;
  });
  // Click-to-drill drawer — identical mechanism to Global Performance (same
  // totalFilter/rowFilter mapping, same drawer). Clicking an already-open slice
  // closes it (Global's toggle semantics).
  const [drawerFilter, setDrawerFilter] = useState<DrawerFilter | null>(null);
  const [drawerBlocked, setDrawerBlocked] = useState(false);
  const baseAgentName = useBaseAgentNames();

  const setFilter = (patch: Partial<CampaignFilterState>) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, ...patch }));
  };

  // Player lookup — debounced. What the one box asks for decides the request: 4+ digits look
  // up a NUMBER (the API refuses less), anything else looks up a player NAME as well as
  // matching campaign names client-side. Under 2 characters nothing is asked.
  const queryKind = classifyQuery(phone);
  useEffect(() => {
    const { kind, needle } = classifyQuery(phone);
    if (kind === "none" || kind === "short") {
      setPhoneRes(null);
      setPhoneErr(kind === "short" ? "Enter at least 4 digits of the number." : null);
      return;
    }
    let stale = false;
    setPhoneLoading(true);
    const t = setTimeout(async () => {
      try {
        const param = kind === "phone" ? `phone=${encodeURIComponent(needle)}` : `name=${encodeURIComponent(needle)}`;
        const res = await fetch(`/api/dashboard/campaigns/phone-lookup?${param}`, { cache: "no-store" });
        const json = (await res.json()) as PhoneLookup & { error?: string };
        if (stale) return;
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setPhoneRes(json);
        setPhoneErr(null);
        setPage(1);
      } catch (e) {
        if (!stale) {
          setPhoneRes(null);
          setPhoneErr(e instanceof Error ? e.message : "Lookup failed");
        }
      } finally {
        if (!stale) setPhoneLoading(false);
      }
    }, 400);
    return () => { stale = true; clearTimeout(t); };
  }, [phone]);

  // The server returns ALL live campaigns with LIFETIME metrics regardless of from/to (it does not
  // window them). So we fetch ONCE and let the date range filter the list client-side (see `visible`
  // + activeInRange). No refetch on date change — that would re-run a heavy fetchAllRows for identical
  // data. The date range narrows WHICH campaigns are listed (by activity overlap); the numbers stay lifetime.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/campaigns`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Resp;
      setData(json);
      saveSnapshot("dashboard.campaigns", json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Stale-while-revalidate (2026-08-05): paint the last session's snapshot
    // instantly (skeleton gates on !data; `loading` renders the non-destructive
    // "Updating…" pill), then load() replaces it.
    const snap = loadSnapshot<Resp>("dashboard.campaigns");
    if (snap) setData(snap);
    load();
  }, [load]);

  // Reset to page 1 whenever a filter/sort/date changes — done in the handlers (matches the SortControl
  // pattern in RankedTables), NOT a state→state effect. `safePage` still clamps as a safety net so you
  // never land on an empty page.
  // Status is ONE choice with an All (mockup): pick Running and the others hide. `hidden`
  // keeps its shape underneath so every consumer (rows, options, summary) is unchanged.
  const campStatus: "all" | DisplayStatus = hidden.size === 0 ? "all" : (STATUS_ORDER.find((s) => !hidden.has(s)) ?? "all");
  const selectStatus = (s: "all" | DisplayStatus) => {
    setPage(1);
    setHidden(s === "all" ? new Set() : new Set(STATUS_ORDER.filter((x) => x !== s)));
  };

  // Recurring PARENTS are schedules, not dialers (Jasiel 2026-08-07): they
  // never place a call themselves, so they showed as permanent all-zero rows.
  // They stay visible on /campaigns (Always-on section); here only campaigns
  // that actually dial — fixed ones and spawned children — are listed, summed,
  // and exported.
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => r.scheduleType !== "recurring"), [data]);

  // Date range (client-side): keep campaigns whose activity span overlaps the picked [from, to].
  const fromMs = parseDayMs(from, false);
  const toMs = parseDayMs(to, true);
  // Phone lookup narrows to the campaigns holding the number (Val's "filter +
  // phone number interaction": records for that number WITHIN the filtered set).
  const phoneCampaignIds = useMemo(
    () => (phoneRes ? new Set(phoneRes.matches.map((m) => m.campaignId)) : null),
    [phoneRes],
  );
  // Family labels come from the recurring parents themselves. The API lists them alongside the
  // runs (they are filtered out of `rows` above because a parent never dials); the picker in
  // Global Performance labels the same parents the same way, so the two surfaces agree.
  const parentLabel = useMemo(() => {
    const parents = (data?.rows ?? [])
      .filter((r) => r.scheduleType === "recurring")
      .map((r) => ({ id: r.id, name: r.name, brand: r.cioWorkspace, startAt: r.startAt }));
    return campaignGroupHeaderLabels(parents);
  }, [data]);
  // The play a run belongs to, for the family chips, from its FAMILY's label. A one-off has no
  // family and no play ("" → no chip): the first run on real data made 84 test campaigns into 84
  // chips. The label leads with the friendly country ("Australia"); the row carries the token
  // ("AU"), so the friendly name comes from the campaign name, the way the label built it.
  const playOfRow = (r: Row): string => {
    const label = r.parentCampaignId ? parentLabel.get(r.parentCampaignId) : null;
    return label ? playOf(label, formatCampaign(r.name).country || r.country, brandLabel(r.cioWorkspace)) : "";
  };
  // The one search box, as a row predicate. A number narrows to the campaigns holding it; a
  // name keeps a row if the CAMPAIGN name matches OR a PLAYER by that name is in it (the
  // mockup's rule); a refused or unfinished query filters nothing rather than emptying the table.
  const queryMatch = (r: Row): boolean => {
    if (queryKind.kind === "phone") return phoneCampaignIds === null || phoneCampaignIds.has(r.id);
    if (queryKind.kind === "name") return matchesCampaignName(r.name, queryKind.needle) || (phoneCampaignIds?.has(r.id) ?? false);
    return true;
  };
  const pickedSet = pickedIds.length ? new Set(pickedIds) : null;
  const visible = rows
    .filter(
      (r) =>
        !hidden.has(r.displayStatus) &&
        activeInRange(r, fromMs, toMs) &&
        matchesCampaignFilters(r, filters) &&
        (pickedSet === null || pickedSet.has(r.id)) &&
        (play === "" || playOfRow(r) === play) &&
        queryMatch(r),
    )
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));


  // Agent chip identity — the SAME resolution CampaignRow renders (base agent
  // name, falling back to the voice), so the dropdown can never disagree with
  // the chips in the rows.
  const agentLabelOf = useCallback(
    (r: Pick<Row, "baseAssistantId" | "voiceId" | "agentLabel">): string =>
      baseAgentName(r.baseAssistantId) ?? voiceName(r.voiceId, { short: true }) ?? r.agentLabel ?? "Unknown agent",
    [baseAgentName],
  );

  // Dropdown options derive from status+date-scoped rows (not the fully
  // filtered set — a picked option must not vanish from its own dropdown).
  const optionRows = useMemo(
    () => rows.filter((r) => !hidden.has(r.displayStatus) && activeInRange(r, fromMs, toMs)),
    [rows, hidden, fromMs, toMs],
  );
  // The plays in scope, for the family chips: distinct, sorted, from the same status+date
  // scoped rows the other axes derive from. One value = no chips (nothing to narrow).
  const plays = useMemo(
    () => [...new Set(optionRows.map(playOfRow).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    // playOfRow is a derived fn over parentLabel; key on its inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [optionRows, parentLabel],
  );
  // The section's campaign picker: every run in scope as a selectable option, grouped by its
  // family exactly as Global's picker groups them (same label functions, same parent ids).
  const pickerOptions: GroupableOption[] = useMemo(
    () => optionRows.map((r) => {
      const label = formatCampaign(r.name).display;
      const parent = r.parentCampaignId ? parentLabel.get(r.parentCampaignId) ?? "" : "";
      return { value: r.id, label, search: `${label} ${parent} ${r.name}`, parentId: r.parentCampaignId ?? null, runLabel: campaignRunLabel(r.name, r.startAt) };
    }),
    [optionRows, parentLabel],
  );
  const pickerParentLabels = useMemo(() => Object.fromEntries(parentLabel), [parentLabel]);
  // How many distinct values each facet holds in scope, shown in the Group menu (mockup):
  // "Family (11)" says what grouping will do before it is chosen.
  const facetCounts = useMemo<Record<GroupFacet, number>>(() => {
    const distinct = (f: (r: Row) => string) => new Set(optionRows.map(f)).size;
    return {
      // parents only: one-offs are families of one, and counting them read "Family (95)" against
      // the band's "11 families" on real data
      family: new Set(optionRows.map((r) => r.parentCampaignId).filter(Boolean)).size,
      country: distinct((r) => r.country),
      brand: distinct((r) => brandKeyOf(r)),
      agent: distinct((r) => agentKeyOf(r)),
      script: distinct((r) => scriptKeyOf(r)),
      none: optionRows.length,
    };
  }, [optionRows]);
  const countryOptions: DropdownOption[] = useMemo(() => {
    const uniq = [...new Set(optionRows.map((r) => r.country).filter(Boolean))].sort();
    // the All option states how many values are in scope (mockup): a menu of one narrows nothing, and says so
    return [{ value: "", label: `All countries (${uniq.length})` }, ...uniq.map((c) => ({ value: c, label: c }))];
  }, [optionRows]);
  const agentOptions: DropdownOption[] = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const r of optionRows) {
      const key = agentKeyOf(r);
      if (key && !byKey.has(key)) byKey.set(key, agentLabelOf(r));
    }
    return [
      { value: "", label: `All voice agents (${byKey.size})` },
      ...[...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ];
  }, [optionRows, agentLabelOf]);
  const scriptOptions: DropdownOption[] = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const r of optionRows) {
      const key = scriptKeyOf(r);
      if (!byKey.has(key)) byKey.set(key, key === NO_SCRIPT ? "No script" : (r.scriptName ?? "Unnamed script"));
    }
    return [
      { value: "", label: `All scripts (${byKey.size})` },
      ...[...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
    ];
  }, [optionRows]);
  const brandChoices = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const r of optionRows) {
      const key = brandKeyOf(r);
      if (!byKey.has(key)) byKey.set(key, brandLabel(r.cioWorkspace));
    }
    return [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [optionRows]);
  const toggleBrand = (key: string) =>
    setFilter({
      brands: filters.brands.includes(key) ? filters.brands.filter((b) => b !== key) : [...filters.brands, key],
    });

  // Summary + export: windowed sums over the SAME rollup rows the table rows
  // were built from, scoped to exactly the ids on screen — so the summary block
  // always equals the sum of the listed rows (Val 2026-08-07).
  const rollup = data?.rollup ?? null;
  const summaryPerf = useMemo(
    () => (rollup ? summarizeRollupWindow(rollup.calls, rollup.sms, new Set(visible.map((r) => r.id)), fromMs, toMs, rollup.moves ?? []) : null),
    // visible is derived (not state) — key the memo on its identity inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rollup, rows, hidden, fromMs, toMs, filters, phoneCampaignIds, pickedIds, play, phone],
  );

  // Drawer scope: the records endpoint takes campaignIds (≤ MAX_CAMPAIGNS) +
  // the custom window + the phone needle — so a drill-down shows records for
  // exactly the filtered campaigns, and, when a player search is active, only
  // that number's records (Val's interaction requirement, in the drawer too).
  const todayStr = new Date().toISOString().slice(0, 10);
  const drawerFilters: GlobalFilters = {
    range: from || to ? "custom" : "lifetime",
    // The drawer needs BOTH bounds for a custom window; synthesize the open
    // side (2026-04-01 predates the first call ever; today closes an open end).
    from: from || to ? (from || "2026-04-01") : undefined,
    to: from || to ? (to || todayStr) : undefined,
    campaignIds: drawerFamilyIds ?? visible.map((r) => r.id),
    country: "",
    prompt: "",
    // the records route reads this as a NUMBER needle; a name query must not reach it
    phone: queryKind.kind === "phone" ? phone : "",
  };
  const sameSlice = (a: DrawerFilter | null, b: DrawerFilter) =>
    !!a && a.status === b.status && a.outcome === b.outcome && a.smsOnly === b.smsOnly;
  // `familyIds` = a FAMILY card opened the drawer, scoped to that family's runs; null = the
  // section summary did, scoped to everything listed. The guard counts whichever scope applies.
  const guardScope = (familyIds: string[] | null): boolean => {
    const blocked = (familyIds ?? visible).length > MAX_CAMPAIGNS;
    setDrawerBlocked(blocked);
    return blocked;
  };
  const openTotal = (card: "callAttempts" | "reached" | "sms", familyIds: string[] | null = null) => {
    if (guardScope(familyIds)) return;
    setDrawerFamilyIds(familyIds);
    setDrawerFilter((prev) => { const next = totalFilter(card); return sameSlice(prev, next) ? null : next; });
  };
  const openRow = (card: "callAttempts" | "reached" | "sms", row: PerfRow, familyIds: string[] | null = null) => {
    if (guardScope(familyIds)) return;
    setDrawerFamilyIds(familyIds);
    setDrawerFilter((prev) => { const next = rowFilter(card, row.key, row.label); return sameSlice(prev, next) ? null : next; });
  };
  const exportCsv = () => {
    if (!rollup || visible.length === 0) return;
    const csv = buildCampaignPerfCsv({
      rows: visible,
      callRollup: rollup.calls,
      smsRollup: rollup.sms,
      moves: rollup.moves ?? [],
      fromMs,
      toMs,
      brandLabelOf: (ws) => brandLabel(ws),
      agentLabelOf: (r) => agentLabelOf(r as unknown as Row),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `voizo-campaign-performance-${stamp}.csv`);
  };

  // Phone strip: matches inside the visible set (with campaign names), and a
  // count of matches the current filters exclude.
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const visibleIds = useMemo(() => new Set(visible.map((r) => r.id)), [visible]);
  const phoneMatchesShown = phoneRes ? phoneRes.matches.filter((m) => visibleIds.has(m.campaignId)) : [];
  const phoneMatchesHidden = phoneRes ? phoneRes.matches.length - phoneMatchesShown.length : 0;

  const groupLabels: GroupLabels = {
    family: (pid) => parentLabel.get(pid) ?? null,
    brand: (ws) => brandLabel(ws),
    agent: (r) => agentLabelOf(r as unknown as Row),
    fallbackName: (r) => formatCampaign(r.name).display,
  };
  // Groups follow the row sort: metric sorts by the group's sum, newest by its newest run.
  const groups = sortGroups(
    groupCampaignRows(
      visible.map((r) => ({
        ...r,
        attempts: r.perf.callAttempts.total,
        conversations: r.perf.reached.total,
        sms: r.perf.sms.total,
      })),
      groupBy,
      groupLabels,
    ),
    sort,
  );
  const familyCount = groups.filter((g) => !g.single).length;
  // "run N of M" for same-day twins, counted over EVERY run loaded (not the page, not the
  // filtered set): which run of the day this is, is a fact about the estate, so narrowing a
  // filter must not renumber it.
  const ordinals = useMemo(
    () => runOrdinals(rows.map((r) => ({ ...r, attempts: r.perf.callAttempts.total, conversations: r.perf.reached.total, sms: r.perf.sms.total }))),
    [rows],
  );
  // The scope line names the unit that exists: families when grouping folds runs, runs alone
  // otherwise. "287 campaigns" was a count the operator could not reconcile with the rows.
  const runsWord = `${visible.length} ${visible.length === 1 ? "run" : "runs"}`;
  const scopeLabel = `${groupBy !== "none" && familyCount > 0 ? `${familyCount} ${familyCount === 1 ? "family" : "families"} · ` : ""}${runsWord} · ${
    from || to ? "metrics in the picked date range" : "lifetime metrics"
  }`;

  // Pages are pages of GROUPS. Under Group: None every group is one run, so this is exactly
  // the flat table it always was.
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageGroups = groups.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // `underHeader`: the row sits under a family header that already says country, name and
  // brand, so the title only has to say WHICH RUN it is (prod's campaignRunLabel, written for
  // this case). Under any other facet the header does not carry the name, so the name stays.
  const rowDataOf = (r: Row, underHeader = false): CampaignRowData => ({
    id: r.id,
    name: r.name,
    country: r.country,
    cioWorkspace: r.cioWorkspace,
    voiceId: r.voiceId,
    agentLabel: r.agentLabel,
    baseAssistantId: r.baseAssistantId,
    scheduleType: r.scheduleType,
    status: r.displayStatus,
    timeLabel: runWindow(r),
    players: r.players,
    startAt: r.startAt,
    perf: r.perf,
    titleOverride: underHeader ? campaignRunLabel(r.name, r.startAt) || undefined : undefined,
    runOrdinal: ordinals.get(r.id) || undefined,
  });
  const renderRun = (r: Row, underHeader = false) => (
    <CampaignRow
      key={r.id}
      c={rowDataOf(r, underHeader)}
      expanded={expanded.has(r.id)}
      onToggle={() => toggleExpand(r.id)}
      slice={slices[r.id]?.slice}
      sliceLabel={slices[r.id]?.label}
      onMetricPick={(s, l) => pickMetric(r.id, s, l)}
      onClearSlice={() => clearSlice(r.id)}
      onViewPrompt={() => setPromptFor({ id: r.id, title: formatCampaign(r.name).display })}
      trailing={
        <>
          <span className="text-[var(--border-2)]">·</span>
          <Link
            href={`/campaigns/v2/${r.id}`}
            className="inline-flex items-center gap-1 text-[var(--text-2)] hover:text-primary transition-colors"
          >
            open in campaign <ArrowRight size={10} />
          </Link>
        </>
      }
    />
  );

  return (
    <>
    <WidgetCard
      title="Campaign Performance"
      context="status, run window & full call records · its own date range"
      actions={
        <div className="flex items-center gap-2">
          {/* Mass export (Val 2026-08-07): one CSV, one row per campaign
              currently matching the filters, windowed metrics + TOTAL row. */}
          <button
            type="button"
            onClick={exportCsv}
            disabled={!rollup || visible.length === 0}
            title={!rollup ? "Loading…" : `Export ${visible.length} campaigns as CSV (opens in Excel)`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <Download size={13} /> Export CSV
          </button>
          <SortControl
            sort={sort}
            setSort={(s) => { setSort(s); setPage(1); }}
            keys={["newest", "calls", "reached", "sms"]}
            labels={{ newest: "Newest", calls: "Call Attempts", reached: "Conversations", sms: "SMS" }}
          />
        </div>
      }
      bodyClassName="p-0"
      footer={
        <Pagination
          currentPage={safePage}
          totalPages={totalPages}
          totalItems={groups.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          // the unit a page holds: a group when grouping, a run when not. Calling a run a
          // "family" would be a count the operator cannot reconcile against anything else.
          noun={groupBy === "none" ? "runs" : familyCount === groups.length ? "families" : "families and one-offs"}
        />
      }
    >
      {/* The filter bar (dashboard mockup, ported 2026-09-03). ONE row of filters, left to right:
          status (one at a time, with All) · the play a family runs · country / agent / script,
          each stating how many values are in scope · brand when more than one · ONE search box
          for a campaign name, a player's number or a player's name · the section's own campaign
          picker · the date range on the right. View controls (Group, parent summaries) sit on
          the summary row below, because they change how runs are stacked, never which are listed. */}
      <div className="flex items-center gap-2 flex-wrap px-3.5 py-2.5 border-b border-[var(--border)]">
        {(["all", ...STATUS_ORDER] as const).map((s) => {
          const on = s === campStatus;
          const cls = s === "all" ? "bg-blue-500/15 text-blue-400 border-blue-500/40" : STATUS_META[s].cls;
          return (
            <button
              key={s}
              type="button"
              onClick={() => selectStatus(s)}
              aria-pressed={on}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                on ? cls : "bg-transparent text-[var(--text-3)] border-[var(--border)] hover:text-[var(--text-2)]"
              }`}
            >
              {s === "all" ? "All" : STATUS_META[s].label}
            </button>
          );
        })}
        {plays.length > 1 && (
          <>
            <span className="w-px h-5 bg-[var(--border)] mx-1" />
            {/* Family chips: the PLAY (REACTIVATION, RND REG YESTERDAY, ...), the same across brands
                and markets, derived from each family's label. One chip per play plus All. */}
            {["", ...plays].map((p) => {
              const on = p === play;
              return (
                <button
                  key={p || "__all__"}
                  type="button"
                  onClick={() => { setPlay(p); setPage(1); }}
                  aria-pressed={on}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                    on ? "bg-blue-500/15 text-blue-400 border-blue-500/40" : "bg-transparent text-[var(--text-3)] border-[var(--border)] hover:text-[var(--text-2)]"
                  }`}
                  title={p ? `Only families running ${p}` : "Every family"}
                >
                  {p || "All families"}
                </button>
              );
            })}
          </>
        )}
        <span className="w-px h-5 bg-[var(--border)] mx-1" />
        {/* Each axis states how many values are in scope; with one value the control filters
            nothing and says so in its label rather than pretending a menu of one narrows anything. */}
        <StyledSelect size="sm" options={countryOptions} value={filters.country} onChange={(v) => setFilter({ country: v })} placeholder={`All countries (${countryOptions.length})`} />
        <StyledSelect size="sm" options={agentOptions} value={filters.agent} onChange={(v) => setFilter({ agent: v })} placeholder={`All agents (${agentOptions.length})`} />
        <StyledSelect size="sm" options={scriptOptions} value={filters.script} onChange={(v) => setFilter({ script: v })} placeholder={`All scripts (${scriptOptions.length})`} />
        {brandChoices.length > 1 && (
          <>
            <span className="w-px h-5 bg-[var(--border)] mx-1" />
            {brandChoices.map(([key, label]) => {
              const on = filters.brands.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleBrand(key)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                    on
                      ? "bg-blue-500/15 text-blue-400 border-blue-500/40"
                      : "bg-transparent text-[var(--text-3)] border-[var(--border)] hover:text-[var(--text-2)]"
                  }`}
                  title={on ? `Showing ${label} — click to remove` : `Only show ${label} campaigns`}
                >
                  {label}
                </button>
              );
            })}
          </>
        )}
        <span className="w-px h-5 bg-[var(--border)] mx-1" />
        {/* ONE box (mockup): a campaign name, a player's number, or a player's name. Rows narrow
            to the campaigns that match, or that hold a player who does. Replaces the separate
            "Campaign name…" and "Player number…" boxes. */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <input
            type="text"
            value={phone}
            onChange={(e) => { setPhone(e.target.value); setPage(1); }}
            placeholder="Campaign, number or name…"
            aria-label="Search by campaign name, player number or player name"
            title="One box: a campaign name, a player's number, or a player's name."
            className="pl-8 pr-7 py-1.5 w-[230px] rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
          />
          {phone && (
            <button type="button" aria-label="Clear the search" onClick={() => { setPhone(""); setPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-1)]">
              <X size={13} />
            </button>
          )}
        </div>
        {/* The section's own campaign picker — the same control as Global's, grouped by family,
            capped at 7 per family with show-all. Ticked runs govern the rows; none = all. */}
        <div className="min-w-[190px]">
          <CampaignPicker
            label={`All campaigns (${pickerOptions.length})`}
            options={pickerOptions}
            parentLabels={pickerParentLabels}
            selected={pickedIds}
            onChange={(ids) => { setPickedIds(ids); setPage(1); }}
          />
        </div>
        {phoneLoading && <span className="text-[11px] text-[var(--text-3)]">Searching…</span>}
        {phoneErr && <span className="text-[11px] text-amber-400">{phoneErr}</span>}
        {(anyCampaignFilterActive(filters) || phone || pickedIds.length > 0 || play || campStatus !== "all") && (
          <button
            type="button"
            onClick={() => { setFilters(NO_CAMPAIGN_FILTERS); setPhone(""); setPickedIds([]); setPlay(""); setHidden(new Set()); setPage(1); }}
            className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2 py-1 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)] transition"
          >
            Clear filters
          </button>
        )}
        {/* The window (mockup): one button reading "Aug 16 – Aug 22" that opens the shared calendar.
            Counts on its cells come from every run in the status scope, the window itself excluded,
            because the calendar is how the window is chosen. */}
        <span className="ml-auto">
          <RangeCalendar
            from={from}
            to={to}
            runDates={rows.filter((r) => !hidden.has(r.displayStatus)).map((r) => (r.startAt ?? "").slice(0, 10)).filter(Boolean)}
            onApply={(f, t) => { setFrom(f); setTo(t); setPage(1); }}
            ariaLabel="Pick the Campaign Performance window"
          />
        </span>
        {loading && <span className="text-[11px] text-[var(--text-3)]">Updating…</span>}
        {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
      </div>
      {/* Player-number results — records for the number WITHIN the filtered campaigns (Val 2026-08-07). */}
      {phoneRes && (
        <div className="px-3.5 py-2.5 border-b border-[var(--border)] flex flex-col gap-1.5">
          <div className="text-[11px] text-[var(--text-3)]">
            {phoneMatchesShown.length === 0
              ? `No campaigns in the current filters hold a number matching “${phoneRes.query}”.`
              : `Number found in ${phoneMatchesShown.length} ${phoneMatchesShown.length === 1 ? "campaign" : "campaigns"}:`}
            {phoneMatchesHidden > 0 && (
              <span> ({phoneMatchesHidden} more {phoneMatchesHidden === 1 ? "match is" : "matches are"} outside the current filters — clear filters to see them)</span>
            )}
            {phoneRes.truncated && <span className="text-amber-400"> · showing the first 500 matches, refine the number</span>}
          </div>
          {phoneMatchesShown.slice(0, 12).map((m) => {
            const camp = rowById.get(m.campaignId);
            return (
              <div key={m.numberId} className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-mono text-[var(--text-1)]">{m.phone}</span>
                {m.displayName && <span className="text-[var(--text-2)]">{m.displayName}</span>}
                <span className="text-[var(--text-3)]">in</span>
                <span className="text-[var(--text-2)]">{camp ? formatCampaign(camp.name).display : m.campaignId}</span>
                <span className="px-2 py-0.5 rounded-full border border-[var(--border)] text-[11px] text-[var(--text-2)]">
                  {DISPO_LABEL[deriveRecordStatus(m.outcome, false)]}
                </span>
                <span className="text-[var(--text-3)]">
                  {m.attemptCount === 0 ? "never called" : `${m.attemptCount} ${m.attemptCount === 1 ? "call attempt" : "call attempts"}`}
                  {m.smsSent ? " · SMS sent" : ""}
                </span>
              </div>
            );
          })}
          {phoneMatchesShown.length > 12 && (
            <div className="text-[11px] text-[var(--text-3)]">…and {phoneMatchesShown.length - 12} more in these campaigns.</div>
          )}
        </div>
      )}

      {/* View controls (mockup): how runs are STACKED, never which are listed, so they sit apart
          from the filter row. Group states how many values each facet holds; Show parent
          summaries adds the three cards under every family header. */}
      <div className="px-3.5 pt-3 pb-1 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-[var(--text-3)] inline-flex items-center gap-1">
          Group
          <Hint content="Group the list. It changes how runs are stacked, never which runs are listed. A family is a recurring campaign and its daily runs.">
            <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--border-2)] text-[9px] cursor-help select-none">i</span>
          </Hint>
        </span>
        <StyledSelect
          size="sm"
          options={GROUP_FACETS.map((f) => ({ value: f.key, label: f.key === "none" ? f.label : `${f.label} (${facetCounts[f.key]})` }))}
          value={groupBy}
          onChange={(v) => changeGroupBy((v || "family") as GroupFacet)}
          placeholder="Family"
        />
        {groupBy !== "none" && familyCount > 0 && (
          <>
            <span className="w-px h-5 bg-[var(--border)] mx-1" />
            <button
              type="button"
              onClick={toggleFamilySummaries}
              aria-pressed={showFamilySummaries}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition"
            >
              {showFamilySummaries ? <EyeOff size={13} /> : <Eye size={13} />}
              {showFamilySummaries ? "Hide parent summaries" : "Show parent summaries"}
            </button>
            <Hint content="Each summary sums exactly the cells of that family's runs in the selected window. The filters above recompute it. The All campaigns band below is always there; this adds one block per family.">
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--border-2)] text-[9px] text-[var(--text-3)] cursor-help select-none">i</span>
            </Hint>
          </>
        )}
        {drawerBlocked && (
          <span className="text-[11px] text-amber-400">
            Too many campaigns to drill into records ({visible.length} &gt; {MAX_CAMPAIGNS}) — narrow the filters first.
          </span>
        )}
      </div>
      {/* The All campaigns band (mockup): ALWAYS on. The summary of every family in the current
          filters, the same three cards as Global once had, summed over exactly the runs listed. */}
      {summaryPerf && (
        <div className="px-3.5 pb-2">
          <div className="text-[12px] mb-2">
            <span className="font-semibold text-[var(--text-1)]">All campaigns</span>
            <span className="text-[var(--text-3)]"> — every {groupBy === "none" ? "run" : "family"} in the current filters · {scopeLabel}</span>
          </div>
          <PerformanceCards
            perf={summaryPerf}
            showDeltas={false}
            /* Wrapped, not passed through: the cards' third argument is a parent KEY (a
               string) and openRow's third is the family scope (ids). Passing openRow
               straight in would have handed a string to the scope. tsc caught it. */
            onOpenTotal={(card) => openTotal(card)}
            onOpenRow={(card, row) => openRow(card, row)}
            noDrillHintFor={summaryNoDrillHint}
          />
        </div>
      )}
      {/* ONE drawer for the section summary and every family summary, rendered outside the
          summary's own toggle so a family card can open it while the section summary is hidden. */}
      <div className="px-3.5">
        <RangedRecordsDrawer filters={drawerFilters} filter={drawerFilter} onClose={() => setDrawerFilter(null)} />
      </div>

      {/* Rows (shared camp-row, same as Today's campaigns). WidgetCard is the frame. */}
      <div className="overflow-x-auto">
        <div className="min-w-[920px]">
            {/* Header */}
            <div className={`${CAMPAIGN_ROW_GRID} px-4 py-3 border-b border-[var(--border)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]`}>
              <div>Campaign</div>
              <div>Status</div>
              <div>Call attempts</div>
              <div>Conversations est.</div>
              <div>SMS sent</div>
            </div>

            {visible.length === 0 ? (
              data ? (
                <div className="px-4 py-10 text-center text-xs text-[var(--text-3)]">No campaigns match these filters.</div>
              ) : (
                <CampaignRowsSkeleton rows={PAGE_SIZE} />
              )
            ) : (
              pageGroups.map((g) => {
                // A group of ONE is the run itself: a header over a single row would say the
                // same thing twice (mockup rule, 2026-09-01). Under Group: None every group is one.
                if (g.single) return renderRun(g.rows[0]);
                const open = openGroups.has(g.key);
                const { shown, hidden: more } = visibleChildren(g.rows, showAllIn.has(g.key));
                const st = STATUS_META[g.status];
                return (
                  <div key={g.key} className="border-b border-[var(--border)] last:border-b-0">
                    {/* Family header: name, brand chips when the family spans brands, the three
                        summed metrics under the same columns as the runs, run count, status. */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      aria-expanded={open}
                      className={`${CAMPAIGN_ROW_GRID} w-full items-center px-4 py-3 text-left bg-[var(--bg-elevated)]/40 hover:bg-[var(--bg-hover)] transition-colors`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-[var(--text-3)] transition-transform ${open ? "rotate-90" : ""}`}>
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                        {/* Wraps rather than truncates: the brand, the only thing telling the
                            two REACTIVATION families apart, sits at the END of the label. */}
                        <span className="text-[13px] font-medium text-[var(--text-1)] whitespace-normal break-words">{g.label}</span>
                        {g.brands.length > 1 && g.brands.map((b) => (
                          <span key={b} className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-3)]">{brandLabel(b)}</span>
                        ))}
                        <span className="shrink-0 text-[11px] font-mono text-[var(--text-3)]">{g.rows.length} runs</span>
                      </div>
                      <div>
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${st.cls}`}>
                          {st.pulse && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
                          {st.label}
                        </span>
                      </div>
                      <div className="font-mono text-[15px] text-[var(--text-1)] tabular-nums">{g.attempts.toLocaleString("en-US")}</div>
                      <div className="font-mono text-[15px] text-[var(--text-1)] tabular-nums">{g.conversations.toLocaleString("en-US")}</div>
                      <div className="font-mono text-[15px] text-[var(--text-1)] tabular-nums">{g.sms.toLocaleString("en-US")}</div>
                    </button>
                    {/* The parent summary (mockup): the section's three cards, summed over exactly
                        this family's runs in the picked window, from the same rollup rows the
                        All campaigns band sums. It sits under the HEADER, open or collapsed, so
                        "Show parent summaries" reads every family at once without expanding
                        each. Only for a multi-run group (this branch), never for a group of one:
                        a summary of one row prints the row back at itself. Cards drill the shared
                        drawer, scoped to this family. */}
                    {showFamilySummaries && rollup && (
                      <div className="px-3.5 py-2 border-l-2 border-[var(--border-2)] ml-4">
                        <PerformanceCards
                          perf={summarizeRollupWindow(rollup.calls, rollup.sms, new Set(g.rows.map((r) => r.id)), fromMs, toMs, rollup.moves ?? [])}
                          showDeltas={false}
                          onOpenTotal={(card) => openTotal(card, g.rows.map((r) => r.id))}
                          onOpenRow={(card, row) => openRow(card, row, g.rows.map((r) => r.id))}
                          noDrillHintFor={summaryNoDrillHint}
                        />
                      </div>
                    )}
                    {open && (
                      <div className="border-l-2 border-[var(--border-2)] ml-4">
                        {shown.map((r) => renderRun(r, groupBy === "family"))}
                        {more > 0 && (
                          // Named by the family's TOTAL, the same rule as the picker: "how many
                          // are there" is the question a capped list provokes.
                          <button
                            type="button"
                            onClick={() => setShowAllIn((s) => new Set(s).add(g.key))}
                            className="w-full px-4 py-2 text-left text-[11.5px] text-primary hover:bg-[var(--bg-hover)] transition-colors"
                            title={`${g.label}: ${more} more run${more === 1 ? "" : "s"} not shown`}
                          >
                            show all {g.rows.length} runs
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
        </div>
      </div>
    </WidgetCard>

    {promptFor && (
      <PromptModal campaignId={promptFor.id} title={promptFor.title} onClose={() => setPromptFor(null)} />
    )}
    </>
  );
}
