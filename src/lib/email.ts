/**
 * Minimal email transport — a fetch POST to Resend's REST API. No SDK: for the
 * only caller (the daily-snapshot cron, 7 emails/day) a ~20-line wrapper is
 * lazier than a dependency and adds zero supply-chain surface.
 * ponytail: add the Resend SDK only if retries / idempotency / attachments arrive.
 *
 * Loud-over-silent (feedback_loud_over_silent_skips): a missing env var throws
 * rather than silently no-op'ing, so a misconfig surfaces as a failed cron
 * (→ heartbeat goes stale → alerts-hourly warns) instead of invisible silence.
 */
export async function sendEmail(
  to: string[],
  subject: string,
  html: string,
  text?: string,
): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey) throw new Error("[email] RESEND_API_KEY not set — cannot send");
  if (!from) throw new Error("[email] RESEND_FROM not set — cannot send");

  // Passing both html + text makes Resend send a multipart/alternative message
  // (better spam scoring + a fallback for plain-text / screen-reader / preview clients).
  const payload: Record<string, unknown> = { from, to, subject, html };
  if (text) payload.text = text;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`[email] Resend responded ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return data.id ?? "";
}
