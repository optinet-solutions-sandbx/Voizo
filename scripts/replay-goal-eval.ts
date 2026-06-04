/* Read-only. Replays the NEW consent rule over historical calls and compares to
 * the stored goal_reached (the live OLD output). No re-implementation of old logic.
 * Reports both decisions (goal + SMS), by country, joined to sms_messages_v2.
 *
 * Run (creds passed at run-time, never persisted):
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/replay-goal-eval.ts
 */
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { isVoicemail, hasGenuineCustomerConsent } from "../src/lib/transcriptClassify";

loadEnvConfig(process.cwd()); // loads .env.local from the worktree — secret stays in-file, never in args/chat

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key);

const txt = (t: unknown): string =>
  typeof t === "string"
    ? t
    : t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string"
    ? ((t as { text: string }).text)
    : "";
const country = (name: string | null): string => {
  const m = (name ?? "").match(/^L7_([A-Z]+)_/);
  return m ? m[1] : name ? "OTHER" : "UNKNOWN";
};
const wilson = (k: number, n: number): string => {
  if (!n) return "n=0";
  const p = k / n, z = 1.96, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${(100 * p).toFixed(1)}% [${(100 * (c - h)).toFixed(1)}, ${(100 * (c + h)).toFixed(1)}]`;
};

(async () => {
  const PAGE = 1000;
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("calls_v2")
      .select("id, goal_reached, transcript, campaigns_v2!campaign_id(name)")
      .not("transcript", "is", null)
      .not("goal_reached", "is", null)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    if (!data || data.length < PAGE) break;
  }

  const ids = rows.map((r) => r.id as string);
  const smsByCall = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await db
      .from("sms_messages_v2")
      .select("call_id, status")
      .in("call_id", ids.slice(i, i + 500));
    for (const s of (data ?? []) as Array<{ call_id: string; status: string }>) smsByCall.set(s.call_id, s.status);
  }

  const byCountry: Record<string, { n: number; t2f: number; f2t: number; t2fSent: number }> = {};
  const flips: Array<{ id: string; country: string; sms: string; snippet: string }> = [];
  const f2tFlips: Array<{ id: string; country: string; sms: string; snippet: string }> = [];
  const t2fSmsTally: Record<string, number> = {};
  for (const r of rows) {
    const t = txt(r.transcript);
    const oldGoal = r.goal_reached === true;
    const newGoal = !isVoicemail(t) && hasGenuineCustomerConsent(t);
    const cv = r.campaigns_v2 as { name?: string } | Array<{ name?: string }> | null;
    const name = Array.isArray(cv) ? cv[0]?.name ?? null : cv?.name ?? null;
    const c = country(name);
    const b = (byCountry[c] ??= { n: 0, t2f: 0, f2t: 0, t2fSent: 0 });
    b.n++;
    const sms = smsByCall.get(r.id as string) ?? "none";
    if (oldGoal && !newGoal) {
      b.t2f++;
      if (sms === "sent") b.t2fSent++;
      t2fSmsTally[sms] = (t2fSmsTally[sms] ?? 0) + 1;
      flips.push({ id: r.id as string, country: c, sms, snippet: t.slice(0, 200) });
    }
    if (!oldGoal && newGoal) {
      b.f2t++;
      f2tFlips.push({ id: r.id as string, country: c, sms, snippet: t.slice(0, 200) });
    }
  }

  console.log("=== goal_reached: stored(OLD) vs NEW — by country ===");
  for (const [c, b] of Object.entries(byCountry))
    console.log(`${c}: n=${b.n} | true->false=${b.t2f} (${wilson(b.t2f, b.n)}) of which SMS-was-sent=${b.t2fSent} | false->true=${b.f2t}`);
  const tot = Object.values(byCountry).reduce(
    (a, b) => ({ n: a.n + b.n, t2f: a.t2f + b.t2f, f2t: a.f2t + b.f2t, t2fSent: a.t2fSent + b.t2fSent }),
    { n: 0, t2f: 0, f2t: 0, t2fSent: 0 },
  );
  console.log(`TOTAL: n=${tot.n} | true->false=${tot.t2f} | false->true=${tot.f2t} | unconsented-SMS-now-suppressed=${tot.t2fSent}`);
  console.log(`true->false SMS-status tally: ${JSON.stringify(t2fSmsTally)}`);
  console.log("\n=== true->false flips (OLD success, NEW drops — expect machine/voicemail/no-consent) ===");
  for (const f of flips.slice(0, 40)) console.log(`${f.country} sms=${f.sms} ${f.id}: ${f.snippet.replace(/\n/g, " | ")}`);
  console.log("\n=== false->true flips (NEW success, OLD missed — recovery? or NEW false-positive?) ===");
  for (const f of f2tFlips) console.log(`${f.country} sms=${f.sms} ${f.id}: ${f.snippet.replace(/\n/g, " | ")}`);
})();
