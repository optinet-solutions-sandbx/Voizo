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
import { formatCampaign, distinctBrandLabels, brandLabel } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { triggerDownload } from "@/lib/download";
import PromptModal from "./PromptModal";
import DatePickerField from "@/components/DatePickerField";
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
  agentKeyOf, anyCampaignFilterActive, brandKeyOf, matchesCampaignFilters, scriptKeyOf,
  NO_CAMPAIGN_FILTERS, NO_SCRIPT, type CampaignFilterState,
} from "./campaignFilters";
import { buildCampaignPerfCsv } from "./campaignPerfCsv";
// Grouping (Jasiel 2026-09-02, from the dashboard mockup): runs fold under their family,
// country, brand, voice agent or script. A family is the recurring parent, the same key the
// campaign picker groups by. Children under an open group are capped the way the picker is.
import { groupCampaignRows, sortGroups, runOrdinals, GROUP_FACETS, type GroupFacet, type GroupLabels } from "./campaignGrouping";
import { visibleChildren } from "@/lib/campaignGroups";
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
  const [phone, setPhone] = useState("");
  const [phoneRes, setPhoneRes] = useState<PhoneLookup | null>(null);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneLoading, setPhoneLoading] = useState(false);
  // Summary visibility (Jasiel 2026-08-07: collapsible so the table stays the
  // hero) — remembered across visits like the rest of the section state.
  const [showSummary, setShowSummary] = useState<boolean>(() => loadSnapshot<boolean>("dashboard.campaigns.showSummary") ?? true);
  const toggleSummary = () => setShowSummary((prev) => { const next = !prev; saveSnapshot("dashboard.campaigns.showSummary", next); return next; });
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

  // Player-phone lookup — debounced; needs ≥4 digits (the API refuses less).
  useEffect(() => {
    const needle = phone.replace(/[^\d+]/g, "");
    if (needle.length < 4) {
      setPhoneRes(null);
      setPhoneErr(phone.trim() ? "Enter at least 4 digits." : null);
      return;
    }
    let stale = false;
    setPhoneLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/dashboard/campaigns/phone-lookup?phone=${encodeURIComponent(needle)}`, { cache: "no-store" });
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
  const toggleStatus = (s: DisplayStatus) => {
    setPage(1);
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
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
  const visible = rows
    .filter(
      (r) =>
        !hidden.has(r.displayStatus) &&
        activeInRange(r, fromMs, toMs) &&
        matchesCampaignFilters(r, filters) &&
        (phoneCampaignIds === null || phoneCampaignIds.has(r.id)),
    )
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));

  // Brands present in the CURRENTLY-LISTED rows (post status/date filter) — the
  // scope line must describe what's on screen, not everything in the database.
  const visibleBrands = distinctBrandLabels(visible.map((r) => r.cioWorkspace));

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
  const countryOptions: DropdownOption[] = useMemo(() => {
    const uniq = [...new Set(optionRows.map((r) => r.country).filter(Boolean))].sort();
    return [{ value: "", label: "All countries" }, ...uniq.map((c) => ({ value: c, label: c }))];
  }, [optionRows]);
  const agentOptions: DropdownOption[] = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const r of optionRows) {
      const key = agentKeyOf(r);
      if (key && !byKey.has(key)) byKey.set(key, agentLabelOf(r));
    }
    return [
      { value: "", label: "All voice agents" },
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
      { value: "", label: "All scripts" },
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
    [rollup, rows, hidden, fromMs, toMs, filters, phoneCampaignIds],
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
    phone,
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

  // Family labels come from the recurring parents themselves. The API lists them alongside the
  // runs (they are filtered out of `rows` above because a parent never dials); the picker in
  // Global Performance labels the same parents the same way, so the two surfaces agree.
  const parentLabel = useMemo(() => {
    const parents = (data?.rows ?? [])
      .filter((r) => r.scheduleType === "recurring")
      .map((r) => ({ id: r.id, name: r.name, brand: r.cioWorkspace, startAt: r.startAt }));
    return campaignGroupHeaderLabels(parents);
  }, [data]);
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
      {/* Table-level filters (independent of the global bar). */}
      <div className="flex items-center gap-2 flex-wrap px-3.5 py-2.5 border-b border-[var(--border)]">
        {STATUS_ORDER.map((s) => {
          const on = !hidden.has(s);
          const m = STATUS_META[s];
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                on ? m.cls : "bg-transparent text-[var(--text-3)] border-[var(--border)] opacity-50"
              }`}
            >
              {m.label}
            </button>
          );
        })}
        <span className="w-px h-5 bg-[var(--border)] mx-1" />
        <DatePickerField value={from} onChange={(v) => { setFrom(v); setPage(1); }} placeholder="From date" ariaLabel="From date" />
        <span className="text-[var(--text-3)] text-xs">→</span>
        <DatePickerField value={to} onChange={(v) => { setTo(v); setPage(1); }} placeholder="To date" ariaLabel="To date" />
        {(from || to) && (
          <button type="button" onClick={() => { setFrom(""); setTo(""); setPage(1); }} className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2 py-1 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)]">
            Reset
          </button>
        )}
        <span className="text-[11px] text-[var(--text-3)]">{from || to ? "activity in range · lifetime totals" : "all campaigns · lifetime totals"}</span>
        {/* Brand scope of the rows actually listed (VOZ-216) — moves with the filters. */}
        {visibleBrands.length > 0 && (
          <span className="text-[11px] text-[var(--text-3)]">
            · {visibleBrands.length === 1 ? "brand" : "brands"}:{" "}
            <span className="text-primary">{visibleBrands.join(" · ")}</span>
          </span>
        )}
        {loading && <span className="text-[11px] text-[var(--text-3)]">Updating…</span>}
        {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
      </div>

      {/* Section filters (Val 2026-08-07): country · brand · voice agent · script · player phone. */}
      <div className="flex items-center gap-2 flex-wrap px-3.5 py-2.5 border-b border-[var(--border)]">
        {/* Group by: one select, prod's control language for "pick one of a list". */}
        <span className="text-[11px] text-[var(--text-3)]">Group</span>
        <StyledSelect
          size="sm"
          options={GROUP_FACETS.map((f) => ({ value: f.key, label: f.label }))}
          value={groupBy}
          onChange={(v) => changeGroupBy((v || "family") as GroupFacet)}
          placeholder="Family"
        />
        <span className="w-px h-5 bg-[var(--border)] mx-1" />
        <StyledSelect size="sm" options={countryOptions} value={filters.country} onChange={(v) => setFilter({ country: v })} placeholder="All countries" />
        <StyledSelect size="sm" options={agentOptions} value={filters.agent} onChange={(v) => setFilter({ agent: v })} placeholder="All voice agents" />
        <StyledSelect size="sm" options={scriptOptions} value={filters.script} onChange={(v) => setFilter({ script: v })} placeholder="All scripts" />
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
        {/* Campaign-name search (Val 2026-08-25). Token-AND over the name, so "rnd au"
            finds "…RND REG YESTERDAY AU" and a date finds that day's runs. Purely
            client-side over rows already loaded — no request, no debounce needed. */}
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <input
            type="text"
            value={filters.name}
            onChange={(e) => setFilter({ name: e.target.value })}
            placeholder="Campaign name…"
            aria-label="Search campaigns by name"
            className="pl-8 pr-7 py-1.5 w-[210px] rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
          />
          {filters.name && (
            <button type="button" aria-label="Clear campaign name search" onClick={() => setFilter({ name: "" })} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-1)]">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Player number…"
            aria-label="Search by player phone number"
            className="pl-8 pr-7 py-1.5 w-[180px] rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
          />
          {phone && (
            <button type="button" aria-label="Clear phone search" onClick={() => setPhone("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-1)]">
              <X size={13} />
            </button>
          )}
        </div>
        {phoneLoading && <span className="text-[11px] text-[var(--text-3)]">Searching…</span>}
        {phoneErr && <span className="text-[11px] text-amber-400">{phoneErr}</span>}
        {(anyCampaignFilterActive(filters) || phone) && (
          <button
            type="button"
            onClick={() => { setFilters(NO_CAMPAIGN_FILTERS); setPhone(""); setPage(1); }}
            className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2 py-1 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)]"
          >
            Clear filters
          </button>
        )}
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

      {/* Filter-scoped summary (Val 2026-08-07) — the SAME cards + click-to-drill
          drawer as Global Performance, scoped to exactly the campaigns listed
          below. Collapsible (Jasiel 2026-08-07) and remembered. */}
      <div className="px-3.5 pt-3 pb-1 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={toggleSummary}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition"
        >
          {showSummary ? <EyeOff size={13} /> : <Eye size={13} />}
          {showSummary ? "Hide summary" : "Show summary"}
        </button>
        {groupBy !== "none" && familyCount > 0 && (
          <button
            type="button"
            onClick={toggleFamilySummaries}
            title="Three cards under each open family, summed over that family's runs in the picked window"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition"
          >
            {showFamilySummaries ? <EyeOff size={13} /> : <Eye size={13} />}
            {showFamilySummaries ? "Hide family summaries" : "Show family summaries"}
          </button>
        )}
        <span className="text-[11px] text-[var(--text-3)]">Summary of the runs listed below · {scopeLabel}</span>
        {drawerBlocked && (
          <span className="text-[11px] text-amber-400">
            Too many campaigns to drill into records ({visible.length} &gt; {MAX_CAMPAIGNS}) — narrow the filters first.
          </span>
        )}
      </div>
      {showSummary && summaryPerf && (
        <div className="px-3.5 pb-2">
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
                    {open && (
                      <div className="border-l-2 border-[var(--border-2)] ml-4">
                        {/* The family's own summary: the section's three cards, summed over
                            exactly this family's runs in the picked window, from the same
                            rollup rows the section summary sums. Only for a MULTI-run group
                            (this branch), never for a group of one: a summary of one row
                            prints the row back at itself. Cards drill the shared drawer,
                            scoped to this family. */}
                        {showFamilySummaries && rollup && (
                          <div className="px-3.5 py-2">
                            <PerformanceCards
                              perf={summarizeRollupWindow(rollup.calls, rollup.sms, new Set(g.rows.map((r) => r.id)), fromMs, toMs, rollup.moves ?? [])}
                              showDeltas={false}
                              onOpenTotal={(card) => openTotal(card, g.rows.map((r) => r.id))}
                              onOpenRow={(card, row) => openRow(card, row, g.rows.map((r) => r.id))}
                              noDrillHintFor={summaryNoDrillHint}
                            />
                          </div>
                        )}
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
