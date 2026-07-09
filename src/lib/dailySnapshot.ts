import type { TodayPerfDay, PerfMetric, RateRow } from "@/lib/dashboardAnalytics";

const MS_PER_DAY = 86_400_000;

/**
 * Fixed recipient list from Asana ticket 1216096014477809 (Val, 2026-06-28).
 * Hard-coded on purpose: changing who receives business performance data should
 * go through code review, not a runtime env edit.
 * ponytail: env/DB-driven list only if it starts churning.
 */
export const SNAPSHOT_RECIPIENTS: string[] = [
  "dror@roosterpartners.com",
  "Alex@roosterpartners.com",
  "val@roosterpartners.com",
  "maria.grigorova@roosterpartners.com",
  "meny@roosterpartners.com",
  "Tina@roosterpartners.com",
  "ernie.gabriel@roosterpartners.com",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The previous full UTC day [00:00, 23:59:59.999] relative to `now`, plus a display label. */
export function yesterdayWindowUtc(now: number): {
  startMs: number;
  endMs: number;
  dateLabel: string;
} {
  const d = new Date(now);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const startMs = todayStart - MS_PER_DAY;
  const y = new Date(startMs);
  const dateLabel = `${y.getUTCDate()} ${MONTHS[y.getUTCMonth()]} ${y.getUTCFullYear()}`;
  return { startMs, endMs: todayStart - 1, dateLabel };
}

function fmtPct(pct: number | null): string {
  return pct == null ? "n/a" : `${(pct * 100).toFixed(1)}%`;
}
/** "<count> (<pct of the metric denominator>)" for a bucket row, keyed by PerfRow.key. */
function countPct(m: PerfMetric, key: string): string {
  const r = m.rows.find((row) => row.key === key);
  return `${r?.count ?? 0} (${fmtPct(r?.pct ?? null)})`;
}

type Line = { label: string; value: string };
type Section = { title: string; lines: Line[] };

/**
 * Build the daily-snapshot email {subject, html, text} — the FULL yesterday breakdown at the
 * totals level (every 3-card bucket + %, plus the headline KPI rates). Pure. One `sections` model
 * renders both the inline-styled HTML and the plain-text alternative (multipart) so they never drift.
 * All numbers come straight from computeWindowPerf (buckets) + computeKpis (rates) — no re-derivation.
 */
export function buildSnapshotEmail(
  perf: TodayPerfDay,
  kpis: RateRow,
  dateLabel: string,
  dashboardUrl: string,
): { subject: string; html: string; text: string } {
  const ca = perf.callAttempts;
  const rq = perf.reached;
  const sms = perf.sms;

  const sections: Section[] = [
    {
      title: `Call attempts: ${ca.total}`,
      lines: [
        { label: "Reached", value: countPct(ca, "reached") },
        { label: "Voicemail", value: countPct(ca, "voicemail") },
        { label: "Unreachable", value: countPct(ca, "unreachable") },
        // Only surface in-progress when there is any — a completed prior day is normally all-terminal.
        ...(perf.inFlight > 0 ? [{ label: "In progress", value: String(perf.inFlight) }] : []),
      ],
    },
    {
      title: `Reached quality: ${rq.total} reached`,
      lines: [
        { label: "Positive", value: countPct(rq, "positive") },
        { label: "Neutral", value: countPct(rq, "neutral") },
        { label: "Declined", value: countPct(rq, "declined") },
        { label: "Early hang-up", value: countPct(rq, "early_hangup") },
      ],
    },
    {
      title: `SMS: ${sms.total} sent/delivered`,
      lines: [
        { label: "Reached", value: countPct(sms, "reached") },
        { label: "Voicemail", value: countPct(sms, "voicemail") },
        { label: "Unreachable", value: countPct(sms, "unreachable") },
      ],
    },
    {
      title: "Key rates",
      lines: [
        { label: "Connect rate", value: fmtPct(kpis.connectRate) },
        { label: "Positive response rate", value: fmtPct(kpis.positiveResponseRate) },
        { label: "Voicemail rate", value: fmtPct(kpis.voicemailRate) },
      ],
    },
  ];

  const subject = `Voizo Daily Snapshot — ${dateLabel} (UTC)`;

  const htmlBody = sections
    .map(
      (s) => `
    <tr><td colspan="2" style="padding:18px 0 4px;font-weight:600;font-size:13px;color:#111;border-top:1px solid #eee;">${s.title}</td></tr>${s.lines
      .map(
        (l) => `
    <tr>
      <td style="padding:4px 0 4px 16px;color:#555;font-size:14px;">${l.label}</td>
      <td style="padding:4px 0;text-align:right;font-weight:600;font-size:15px;color:#111;">${l.value}</td>
    </tr>`,
      )
      .join("")}`,
    )
    .join("");

  const html = `<!-- daily snapshot -->
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
  <h1 style="font-size:18px;color:#111;margin:0 0 4px;">Voizo Daily Snapshot</h1>
  <p style="color:#777;font-size:13px;margin:0 0 12px;">Yesterday — ${dateLabel} (00:00&ndash;23:59 UTC)</p>
  <table style="width:100%;border-collapse:collapse;">${htmlBody}
  </table>
  <p style="margin:24px 0 0;">
    <a href="${dashboardUrl}" style="color:#4d90f0;font-size:14px;text-decoration:none;">View full dashboard &rarr;</a>
  </p>
</div>`;

  const textBody = sections
    .map((s) => [s.title, ...s.lines.map((l) => `  ${l.label}: ${l.value}`)].join("\n"))
    .join("\n\n");

  const text = [
    `Voizo Daily Snapshot — ${dateLabel} (UTC)`,
    `Yesterday (00:00–23:59 UTC)`,
    ``,
    textBody,
    ``,
    `View full dashboard: ${dashboardUrl}`,
  ].join("\n");

  return { subject, html, text };
}
