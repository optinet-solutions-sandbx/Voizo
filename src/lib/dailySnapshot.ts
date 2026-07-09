import type { TodayPerfDay, PerfRow } from "@/lib/dashboardAnalytics";

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

function rowCount(m: { rows: PerfRow[] }, key: string): number {
  return m.rows.find((r) => r.key === key)?.count ?? 0;
}
function fmtPct(pct: number | null): string {
  return pct == null ? "&mdash;" : `${(pct * 100).toFixed(1)}%`;
}

/** Build the daily-snapshot email {subject, html}. Pure; inline-styled for email clients. */
export function buildSnapshotEmail(
  perf: TodayPerfDay,
  smsSent: number,
  dateLabel: string,
  dashboardUrl: string,
): { subject: string; html: string } {
  const callsMade = perf.callAttempts.total;
  const reached = rowCount(perf.callAttempts, "reached");
  const voicemail = rowCount(perf.callAttempts, "voicemail");
  const positiveRow = perf.reached.rows.find((r) => r.key === "positive");
  const positive = positiveRow?.count ?? 0;
  const positivePct = fmtPct(positiveRow?.pct ?? null);

  const subject = `Voizo Daily Snapshot — ${dateLabel} (UTC)`;

  const stat = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 0;color:#555;font-size:14px;">${label}</td>
      <td style="padding:8px 0;text-align:right;font-weight:600;font-size:16px;color:#111;">${value}</td>
    </tr>`;

  const html = `<!-- daily snapshot -->
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
  <h1 style="font-size:18px;color:#111;margin:0 0 4px;">Voizo Daily Snapshot</h1>
  <p style="color:#777;font-size:13px;margin:0 0 20px;">Yesterday — ${dateLabel} (00:00&ndash;23:59 UTC)</p>
  <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;">
    ${stat("Calls made", String(callsMade))}
    ${stat("Reached", String(reached))}
    ${stat("Voicemail", String(voicemail))}
    ${stat("Positive response", `${positive} (${positivePct})`)}
    ${stat("SMS sent/delivered", String(smsSent))}
  </table>
  <p style="margin:24px 0 0;">
    <a href="${dashboardUrl}" style="color:#4d90f0;font-size:14px;text-decoration:none;">View full dashboard &rarr;</a>
  </p>
</div>`;

  return { subject, html };
}
