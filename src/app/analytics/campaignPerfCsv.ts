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
  fromMs: number | null;
  toMs: number | null;
  /** Display resolvers injected from the component (they use hooks/catalogs). */
  brandLabelOf: (workspace: string | null) => string;
  agentLabelOf: (row: ExportableCampaignRow) => string;
}): string {
  const { rows, callRollup, smsRollup, fromMs, toMs, brandLabelOf, agentLabelOf } = args;
  const lines: string[] = [HEADER.map(csvCell).join(",")];

  for (const r of rows) {
    const perf = summarizeRollupWindow(callRollup, smsRollup, new Set([r.id]), fromMs, toMs);
    lines.push(
      [
        r.name, brandLabelOf(r.cioWorkspace), r.country, agentLabelOf(r),
        r.scriptName ?? "", r.segmentId ?? "", r.displayStatus, r.scheduleType,
        r.players, r.startAt ?? "", r.lastCallAt ?? "",
        ...metricCells(perf),
      ].map(csvCell).join(","),
    );
  }

  // TOTAL row — the same computation the summary block renders.
  const total = summarizeRollupWindow(callRollup, smsRollup, new Set(rows.map((r) => r.id)), fromMs, toMs);
  const totalPlayers = rows.reduce((s, r) => s + r.players, 0);
  lines.push(
    [
      `TOTAL (${rows.length} campaigns)`, "", "", "", "", "", "", "",
      totalPlayers, "", "",
      ...metricCells(total),
    ].map(csvCell).join(","),
  );

  return CSV_BOM + lines.join("\r\n");
}
