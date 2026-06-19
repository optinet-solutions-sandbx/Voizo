"use client";

// Operator-legible per-campaign summary — the DEFAULT content of a campaigns-list row expand.
// Plain language, leads with the story, then the few numbers that matter; the jargon lives in
// hover tooltips. The dense deep-dive (AnalyticsRowExpand) sits behind an "Advanced" toggle in
// CampaignExpand. Funnel mirrors the collapsed row's numbers (Contacts / Calls / Answered /
// Goal) so nothing has to be reconciled.

import type { CampaignAnalytics } from "@/lib/campaignAnalytics";

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

// Funnel stage colours (Contacts → Calls → Answered → Goal).
const STAGE_BAR = ["bg-[var(--text-3)]", "bg-blue-500", "bg-emerald-500", "bg-amber-500"];

export default function CampaignSummary({ a }: { a: CampaignAnalytics }) {
  // Shared baseline = the largest stage, so bars are comparable and never overflow (a contact
  // can be dialed more than once, so Calls can exceed Contacts on retry-heavy campaigns).
  const base = Math.max(a.targeted, a.totalCalls, a.connected, a.goalCalls, 1);
  const stages = [
    { label: "Contacts", count: a.targeted, hint: "People targeted by this campaign." },
    { label: "Calls", count: a.totalCalls, hint: "Calls placed — a contact can be dialed more than once." },
    { label: "Connected", count: a.connected, hint: "Calls that connected. Includes voicemail." },
    { label: "Goal", count: a.goalCalls, hint: "Calls where the agent reached the campaign's goal." },
  ];

  // Texts actually dispatched (sms_messages_v2 aggregate) — NOT the "sent_sms" outcome bucket.
  // 'Sent' = handed to the provider; mobivate delivery receipts often don't return, so most
  // sit in-flight rather than confirmed-'delivered'.
  const textsSent = a.sms.delivered + a.sms.inFlight;
  const smsSub =
    a.sms.failed > 0
      ? `${a.sms.failed.toLocaleString()} failed`
      : a.sms.delivered > 0
        ? `${a.sms.delivered.toLocaleString()} delivered`
        : textsSent > 0
          ? "awaiting carrier receipts"
          : undefined;

  return (
    <div className="grid gap-4">
      {/* The story — a simple shrinking funnel, plain labels, real counts. */}
      <div className="grid gap-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">How this campaign is doing</div>
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-3" title={s.hint}>
            <span className="w-16 shrink-0 text-xs text-[var(--text-2)]">{s.label}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--bg-elevated)]">
              <div
                className={`h-full rounded ${STAGE_BAR[i]}`}
                style={{ width: `${s.count > 0 ? Math.max((s.count / base) * 100, 2) : 0}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-xs text-[var(--text-1)]">{s.count.toLocaleString()}</span>
          </div>
        ))}
      </div>

      {/* The few numbers that matter — plain words; precise definitions in the tooltips. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Connect"
          value={pct(a.connectRate)}
          sub={`${a.connected.toLocaleString()} of ${a.totalCalls.toLocaleString()} calls`}
          color="text-emerald-400"
          hint="Connected ÷ calls placed. Includes voicemail (no minimum-duration floor) — see Reach for human-only. Same as the Connect column."
        />
        <Stat
          label="Reach"
          value={a.reach.toLocaleString()}
          sub="humans (excl. voicemail)"
          color="text-teal-400"
          hint="Connected calls minus detected voicemails — roughly how many real humans we reached. Calls not yet evaluated for voicemail count as reach, so on older data this can equal Connected."
        />
        <Stat
          label="Voicemail"
          value={pct(a.voicemailRate)}
          sub={a.voicemailRate === null ? "not tracked yet" : `${a.voicemailConnected.toLocaleString()} of ${a.voicemailEvaluated.toLocaleString()} evaluated`}
          color="text-violet-400"
          hint="Share of EVALUATED connected calls that reached voicemail. Voicemail tracking began recently, so this shows — until evaluated calls exist; historical connects read as reach, not voicemail."
        />
        <Stat
          label="Declined"
          value={pct(a.activeDeclineRate)}
          sub="of those engaged"
          color="text-red-400"
          hint="Contacts who said not-interested or declined the offer ÷ everyone the agent engaged. High here means the pitch or offer isn't landing."
        />
        <Stat
          label="Success"
          value={pct(a.conversion)}
          sub={`${a.goalCalls.toLocaleString()} of ${a.connected.toLocaleString()} connected`}
          color="text-amber-400"
          hint="Goal reached ÷ connected calls. The campaign's Success rate — same as the Success column."
        />
        <Stat
          label="Typical call"
          value={a.durationMedian == null ? "—" : `${Math.round(a.durationMedian)}s`}
          sub={a.durationP95 == null ? undefined : `longest 5% ~${Math.round(a.durationP95)}s`}
          color="text-[var(--text-1)]"
          hint="Median length of an answered call."
        />
        <Stat
          label="Texts sent"
          value={textsSent.toLocaleString()}
          sub={smsSub}
          color="text-sky-400"
          hint="Texts dispatched for this campaign (every send, regardless of call outcome). 'Sent' = handed to the SMS provider; carrier delivery receipts often aren't returned, so 'delivered' can read low even when the texts went out. This is NOT the 'sent_sms' disposition bucket."
        />
      </div>
    </div>
  );
}

function Stat({ label, value, sub, hint, color }: {
  label: string; value: string; sub?: string; hint: string; color: string;
}) {
  return (
    <div title={hint} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">{label}</div>
      <div className={`mt-0.5 font-mono text-xl font-bold leading-tight ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-[var(--text-3)]">{sub}</div>}
    </div>
  );
}
