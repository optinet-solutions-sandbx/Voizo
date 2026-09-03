// Mass-export CSV for the Campaign Performance section (Val's Asana comment,
// 2026-08-07): ONE Excel-openable file with one row per campaign currently
// matching the section's filters — identity columns (name, brand, country,
// agent, script, segment) plus metrics windowed to the picked date range —
// and a final TOTAL row. Rows, the TOTAL, and the on-screen summary block all
// come from summarizeRollupWindow over the same rollup rows, so the export can
// never disagree with what the section displays. Per-player call records stay
// on each campaign's own Export dropdown (CSV / Audio / Transcripts).
//
// Pure string builder (unit-tested); the component triggers the download.
// Relative imports: tested modules must resolve without the "@/" alias
// (vitest has no alias config — same note as recordsDisplay.ts).
import { csvCell, CSV_BOM } from "../../lib/download";
import {
  summarizeRollupWindow,
  type CallRollupRow,
  type CampaignMoveRow,
  type SmsRollupRow,
  type PerfMetric,
  type TodayPerfDay,
} from "../../lib/dashboardAnalytics";

export interface ExportableCampaignRow {
  id: string;
  name: string;
  country: string;
  cioWorkspace: string | null;
  displayStatus: string;
  scheduleType: string;
  players: number;
  startAt: string | null;
  lastCallAt: string | null;
  scriptName?: string | null;
  segmentId?: string | null;
}

const bucket = (m: PerfMetric, key: string): number => m.rows.find((r) => r.key === key)?.count ?? 0;
const smsSub = (m: PerfMetric, key: string): number =>
  m.rows.find((r) => r.key === "reached")?.subRows?.find((r) => r.key === key)?.count ?? 0;

const HEADER = [
  "campaign", "brand", "country", "agent", "script", "segmentId", "status", "scheduleType",
  "players", "startAt", "lastCallAt",
  "callAttempts", "reached", "voicemail", "silentPickup", "unreachable",
  "positive", "neutral", "declined", "earlyHangup", "agentTimeout",
  "smsSent", "smsToReached", "smsPositive", "smsNeutral", "smsDeclined",
  "smsEarlyHangup", "smsAgentTimeout", "smsToVoicemail", "smsToSilentPickup", "smsToUnreachable",
];

function metricCells(perf: TodayPerfDay): Array<string | number> {
  const ca = perf.callAttempts;
  const re = perf.reached;
  const sm = perf.sms;
  return [
    ca.total, bucket(ca, "reached"), bucket(ca, "voicemail"), bucket(ca, "silent_pickup"), bucket(ca, "unreachable"),
    bucket(re, "positive"), bucket(re, "neutral"), bucket(re, "declined"),
    bucket(re, "early_hangup"), bucket(re, "agent_timeout"),
    sm.total, bucket(sm, "reached"), smsSub(sm, "positive"), smsSub(sm, "neutral"),
    smsSub(sm, "declined"), smsSub(sm, "early_hangup"), smsSub(sm, "agent_timeout"),
    bucket(sm, "voicemail"), bucket(sm, "silent_pickup"), bucket(sm, "unreachable"),
  ];
}

export function buildCampaignPerfCsv(args: {
  rows: ExportableCampaignRow[];
  callRollup: CallRollupRow[];
  smsRollup: SmsRollupRow[];
  /** Transcript reclassifications at (campaign, day) grain — the export must
   *  carry the same map the summary block does, or the CSV disagrees with the
   *  screen it was exported from. */
  moves: readonly CampaignMoveRow[];
  fromMs: number | null;
  toMs: number | null;
  /** Display resolvers injected from the component (they use hooks/catalogs). */
  brandLabelOf: (workspace: string | null) => string;
  agentLabelOf: (row: ExportableCampaignRow) => string;
  /** Families (Jasiel 2026-09-03): rows are written family by family, each family closed by a
   *  SUBTOTAL line computed the way the TOTAL is. Rows in no family follow, then the TOTAL.
   *  Omitted = the flat file as before. */
  groups?: readonly { label: string; ids: ReadonlySet<string> }[];
}): string {
  const { rows, callRollup, smsRollup, moves, fromMs, toMs, brandLabelOf, agentLabelOf, groups } = args;
  const lines: string[] = [HEADER.map(csvCell).join(",")];

  const rowLine = (r: ExportableCampaignRow): string => {
    const perf = summarizeRollupWindow(callRollup, smsRollup, new Set([r.id]), fromMs, toMs, moves);
    return [
      r.name, brandLabelOf(r.cioWorkspace), r.country, agentLabelOf(r),
      r.scriptName ?? "", r.segmentId ?? "", r.displayStatus, r.scheduleType,
      r.players, r.startAt ?? "", r.lastCallAt ?? "",
      ...metricCells(perf),
    ].map(csvCell).join(",");
  };
  const sumLine = (caption: string, subset: ExportableCampaignRow[]): string => {
    const perf = summarizeRollupWindow(callRollup, smsRollup, new Set(subset.map((r) => r.id)), fromMs, toMs, moves);
    return [
      caption, "", "", "", "", "", "", "",
      subset.reduce((s, r) => s + r.players, 0), "", "",
      ...metricCells(perf),
    ].map(csvCell).join(",");
  };

  if (groups && groups.length) {
    const placed = new Set<string>();
    for (const g of groups) {
      const members = rows.filter((r) => g.ids.has(r.id) && !placed.has(r.id));
      if (members.length === 0) continue;
      for (const r of members) { lines.push(rowLine(r)); placed.add(r.id); }
      lines.push(sumLine(`SUBTOTAL ${g.label} (${members.length} run${members.length === 1 ? "" : "s"})`, members));
    }
    for (const r of rows) if (!placed.has(r.id)) lines.push(rowLine(r));
  } else {
    for (const r of rows) lines.push(rowLine(r));
  }

  // TOTAL row — the same computation the summary block renders.
  lines.push(sumLine(`TOTAL (${rows.length} campaigns)`, rows));

  return CSV_BOM + lines.join("\r\n");
}
