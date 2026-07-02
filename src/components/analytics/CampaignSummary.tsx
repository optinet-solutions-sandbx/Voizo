"use client";

// Operator-legible per-campaign summary — the DEFAULT content of a campaigns-list row expand.
// Calm, proportion-first treatment (chosen over the old saturated card grid):
//   1. OVERVIEW                  — a divided row of top-level counts (Players / Attempts / Reached / SMS)
//   2. CALL ATTEMPTS · BREAKDOWN — one segmented proportion bar (Unreachable / Voicemail / Connected) + legend
//   3. CONNECTED CALLS · OUTCOME — one segmented proportion bar (Positive / Neutral / Declined / Early hangup)
// Each breakdown tier IS a partition, so a single stacked bar shows it at a glance; the numerals stay quiet
// (mono, muted) and color is desaturated + used sparingly. Visible one-line descriptions carry the meaning;
// the fuller, honest caveats live in the hover tooltips. Engineer deep-dive is still behind "Advanced".

import { smsSentOf, type CampaignAnalytics } from "@/lib/campaignAnalytics";
import { type RecordSlice, sliceEq } from "@/app/analytics/recordsDisplay";

// Desaturated accents — color guides the eye, never shouts. Shared by the bar segments + legend dots.
const ACCENT = {
  rose: "#cf8a8a", // unreachable / declined
  violet: "#9f90c9", // voicemail
  green: "#5fb39a", // connected / reached / positive
  grey: "#8b939c", // neutral
  amber: "#c9a86a", // early hangup
} as const;

function sharePct(n: number, base: number): string {
  return base > 0 ? `${((n / base) * 100).toFixed(1)}%` : "—";
}

interface Seg {
  label: string;
  count: number;
  color: string;
  desc: string; // visible one-liner (Val's wording)
  hint?: string; // fuller honest caveat (hover)
  slice: RecordSlice; // click → filter the inline records to this slice
}

export default function CampaignSummary({
  a,
  onPick,
  active,
}: {
  a: CampaignAnalytics;
  onPick?: (slice: RecordSlice, label: string) => void; // click a metric/row → open inline records
  active?: RecordSlice | null; // the currently-open slice (for highlight)
}) {
  // Overview
  const attemptsPerPlayer = a.targeted > 0 ? (a.totalCalls / a.targeted).toFixed(1) : null;
  // App-wide "SMS sent" = sent|delivered (2026-07-02) — reconciles with this stat's own
  // click-to-filter "texted" slice and with the dashboard SMS cards/columns.
  const smsSent = smsSentOf(a.sms);
  const smsSub =
    smsSent === 0
      ? "no texts sent"
      : `${a.sms.delivered.toLocaleString()} delivered${a.sms.failed > 0 ? ` · ${a.sms.failed.toLocaleString()} failed` : ""}`;

  // Tier 2 — call attempts partition (of COMPLETED attempts; in-flight excluded so it sums to 100%).
  const completed = a.connected + a.nonConnectTotal;
  const inFlight = Math.max(0, a.totalCalls - completed);
  const attemptSegs: Seg[] = [
    { label: "Unreachable", count: a.nonConnectTotal, color: ACCENT.rose, desc: "No answer, busy signal, or failed connection", slice: { kind: "outcome", tag: "unreachable" } },
    { label: "Voicemail detected", count: a.voicemailConnected, color: ACCENT.violet, desc: "Call connected but resolved to the player's voicemail", hint: "Voicemail detection began recently — on older calls this reads low (unevaluated connects fall into Reached player).", slice: { kind: "outcome", tag: "voicemail" } },
    { label: "Reached player", count: a.reach, color: ACCENT.green, desc: "Live player answered and engaged with the agent", hint: "Connected minus detected voicemails. Calls not yet evaluated for voicemail count here, so on older data this can run high.", slice: { kind: "reached" } },
  ];

  // Tier 3 — outcome partition (of reached humans). All proxies → "estimated".
  const ob = a.outcomeBreakdown;
  const outcomeSegs: Seg[] = [
    { label: "Positive response", count: ob.positive, color: ACCENT.green, desc: "Expressed interest or accepted the offer", hint: "Reached the campaign goal. Note: 'goal' = agreed to receive the offer SMS — upstream of an actual deposit. Estimated.", slice: { kind: "outcome", tag: "positive" } },
    { label: "Neutral", count: ob.neutral, color: ACCENT.grey, desc: "Listened but gave no clear commitment or signal", hint: "Estimated — the remainder after positive, declined, and early-hangup.", slice: { kind: "outcome", tag: "neutral" } },
    { label: "Declined", count: ob.declined, color: ACCENT.rose, desc: "Explicitly declined the offer or callback", hint: "Estimated from the player's final disposition (declined_offer).", slice: { kind: "outcome", tag: "declined" } },
    { label: "Early hangup", count: ob.earlyHangup, color: ACCENT.amber, desc: "Hung up before intent could be established", hint: "Estimated — a very short call (under 15s) with no goal and no explicit decline.", slice: { kind: "outcome", tag: "early_hangup" } },
  ];

  return (
    <div className="grid gap-1">
      {/* ── Tier 1 · Overview ── */}
      <section className="border-b border-[var(--border)] py-5 first:pt-1">
        <Eyebrow>Overview</Eyebrow>
        <div className="mt-4 grid grid-cols-2 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
          <OverStat value={a.targeted.toLocaleString()} label="Players in campaign" sub="loaded at campaign start" hint="Players loaded into this campaign (the full contact roster) — a campaign property, not affected by the date range." />
          <OverStat value={a.totalCalls.toLocaleString()} label="Call attempts" sub={attemptsPerPlayer ? `avg ${attemptsPerPlayer}× per player` : "—"} hint="Calls placed — a player can be dialed more than once (retries). Lifetime total for this campaign." pick={{ slice: { kind: "all" }, label: "Call attempts" }} onPick={onPick} active={active} />
          <OverStat value={a.reach.toLocaleString()} label="Reached player" sub={`live humans · ${sharePct(a.reach, a.totalCalls)} of attempts`} hint="Live humans = connected − detected voicemails. Unevaluated connects count as reached, so on older data this can equal connected." pick={{ slice: { kind: "reached" }, label: "Reached" }} onPick={onPick} active={active} />
          <OverStat value={smsSent.toLocaleString()} label="SMS sent" sub={smsSub} hint="Offer texts accepted by the provider (sent) or confirmed delivered. Queued and failed sends are excluded. Lifetime total, not date-scoped." pick={{ slice: { kind: "texted" }, label: "SMS sent" }} onPick={onPick} active={active} />
        </div>
      </section>

      {/* ── Tier 2 · Call attempts breakdown ── */}
      <BarTier
        title="Call attempts · breakdown"
        baseNote={`% of ${completed.toLocaleString()} attempts${inFlight > 0 ? ` · ${inFlight.toLocaleString()} in progress` : ""}`}
        segs={attemptSegs}
        total={completed}
        onPick={onPick}
        active={active}
      />

      {/* ── Tier 3 · Customer-reached outcome breakdown ── */}
      <BarTier
        title="Customer reached · outcome breakdown"
        tag="Estimated"
        baseNote={`% of ${a.reach.toLocaleString()} reached`}
        segs={outcomeSegs}
        total={a.reach}
        onPick={onPick}
        active={active}
      />
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-[10.5px] font-semibold uppercase tracking-[0.13em] text-[var(--text-3)]">{children}</span>;
}

function OverStat({
  value,
  label,
  sub,
  hint,
  pick,
  onPick,
  active,
}: {
  value: React.ReactNode;
  label: string;
  sub: string;
  hint: string;
  pick?: { slice: RecordSlice; label: string };
  onPick?: (slice: RecordSlice, label: string) => void;
  active?: RecordSlice | null;
}) {
  const base = "flex flex-col gap-1.5 px-6 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[var(--border)]";
  const isActive = pick && active ? sliceEq(pick.slice, active) : false;
  const inner = (
    <>
      <span className={`font-mono text-[26px] font-medium leading-none tracking-tight [font-variant-numeric:tabular-nums] transition-colors group-hover:text-blue-400 ${isActive ? "text-blue-400" : "text-[var(--text-1)]"}`}>{value}</span>
      <span className="text-[12.5px] font-medium text-[var(--text-2)]">{label}</span>
      <span className="text-[11px] leading-tight text-[var(--text-3)]">{sub}</span>
    </>
  );
  if (pick && onPick) {
    return (
      <button type="button" title={hint} onClick={() => onPick(pick.slice, pick.label)} className={`${base} group cursor-pointer text-left`}>
        {inner}
      </button>
    );
  }
  return <div title={hint} className={base}>{inner}</div>;
}

function BarTier({ title, tag, baseNote, segs, total, onPick, active }: { title: string; tag?: string; baseNote: string; segs: Seg[]; total: number; onPick?: (slice: RecordSlice, label: string) => void; active?: RecordSlice | null }) {
  return (
    <section className="border-b border-[var(--border)] py-5 last:border-b-0">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>{title}</Eyebrow>
        {tag && (
          <span className="rounded border border-[var(--border-2)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-2)]">
            {tag}
          </span>
        )}
        <span className="ml-auto text-[11px] text-[var(--text-3)] [font-variant-numeric:tabular-nums]">{baseNote}</span>
      </div>

      {/* Stacked proportion bar — decorative; the legend below carries every segment as real text. */}
      <div className="mb-5 flex h-4 w-full gap-[2px] overflow-hidden rounded-lg bg-[var(--bg-elevated)]" aria-hidden="true">
        {segs.map((s) =>
          total > 0 && s.count > 0 ? (
            <span key={s.label} className="h-full opacity-90" style={{ width: `${(s.count / total) * 100}%`, background: s.color }} />
          ) : null,
        )}
      </div>

      {/* Legend */}
      <ul className={`grid list-none gap-x-7 gap-y-5 p-0 ${segs.length === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"}`}>
        {segs.map((s) => {
          const isActive = active ? sliceEq(s.slice, active) : false;
          const body = (
            <>
              {/* dot + label */}
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full opacity-90" style={{ background: s.color }} />
                <span className="text-[12.5px] font-medium text-[var(--text-1)]">{s.label}</span>
              </span>
              {/* value sits directly UNDER the label (aligned past the dot) so the number reads with its row */}
              <span className="flex items-baseline gap-1.5 pl-4">
                <span className="font-mono text-[13px] font-semibold text-[var(--text-1)] [font-variant-numeric:tabular-nums]">{sharePct(s.count, total)}</span>
                <span className="font-mono text-[10.5px] text-[var(--text-3)] [font-variant-numeric:tabular-nums]">{s.count.toLocaleString()} of {total.toLocaleString()}</span>
              </span>
              <span className="pl-4 text-[11px] leading-snug text-[var(--text-3)]">{s.desc}</span>
            </>
          );
          return (
            <li key={s.label} title={s.hint ?? s.desc}>
              {onPick ? (
                <button type="button" onClick={() => onPick(s.slice, s.label)} className={`flex w-full flex-col gap-1 rounded-lg -mx-2 px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${isActive ? "bg-[var(--bg-hover)] ring-1 ring-blue-500/25" : ""}`}>
                  {body}
                </button>
              ) : (
                <div className="flex flex-col gap-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
