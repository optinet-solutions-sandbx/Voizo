// src/app/reviews/NorthStarPanel.tsx
// "Did our offers actually reach people?" — the loop's downstream check on Reviews:
// of calls where the bot got a "yes, text me" (goal reached), the share whose offer
// SMS the network confirmed as DELIVERED, plus the leaks (no text sent, text failed,
// or still unconfirmed). Operator-plain copy. Data: GET /api/qa/north-star.
"use client";

import { useEffect, useState } from "react";
import { Target, AlertCircle } from "lucide-react";
import SectionIsland from "../analytics/SectionIsland";
import Hint from "@/components/Hint";

interface NsCampaign {
  id: string;
  name: string;
  goalReached: number;
  delivered: number;
  failed: number;
  inFlight: number;
  noSms: number;
  deliveredAmongGoal: number | null;
}
interface NsPortfolio {
  goalReached: number;
  delivered: number;
  failed: number;
  inFlight: number;
  noSms: number;
  deliveredAmongGoal: number | null;
  failedAmongGoal: number | null;
  noSmsAmongGoal: number | null;
  includedCampaigns: number;
  excludedTestCampaigns: number;
  excludedThinCampaigns: number;
}
interface NsResult {
  portfolio: NsPortfolio;
  perCampaign: NsCampaign[];
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function NorthStarPanel() {
  const [data, setData] = useState<NsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/qa/north-star", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData((await r.json()) as NsResult);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load this panel");
      }
    })();
  }, []);

  const p = data?.portfolio;
  const rate = p?.deliveredAmongGoal ?? null;
  const tone =
    rate == null ? "text-[var(--text-3)]" : rate >= 0.8 ? "text-emerald-400" : rate >= 0.5 ? "text-amber-400" : "text-red-400";
  // Everything sent but nothing confirmed delivered/failed → almost always a
  // delivery-receipt gap (texts go out, receipts don't come back), not real failures.
  const allUnconfirmed = !!p && p.delivered + p.failed === 0 && p.inFlight > 0;

  return (
    <SectionIsland>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Target size={16} className="text-[var(--text-2)]" />
          <h2 className="text-sm font-semibold text-[var(--text-1)]">Did our offers actually reach people?</h2>
        </div>
        {error && (
          <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
            <AlertCircle size={11} /> {error}
          </span>
        )}
      </div>

      <p className="text-[11px] text-[var(--text-3)]">
        When the bot gets a &ldquo;yes, text me,&rdquo; we send the offer by text. This is the share of those texts the
        phone network confirmed as <strong>delivered</strong>. Lots of &ldquo;yes&rdquo; but few delivered = wasted wins.
      </p>

      {data === null ? (
        <div className="text-xs text-[var(--text-3)] py-3">Loading…</div>
      ) : !p || p.goalReached === 0 ? (
        <div className="text-xs text-[var(--text-3)] py-3">No &ldquo;yes, text me&rdquo; calls in real campaigns yet.</div>
      ) : (
        <>
          <div className="flex items-baseline gap-3 flex-wrap">
            <Hint content="Share of 'yes, text me' calls whose offer text the network confirmed as delivered.">
              <span className={`text-3xl font-bold tabular-nums cursor-help ${tone}`}>
                {pct(rate)}
              </span>
            </Hint>
            <span className="text-[11px] text-[var(--text-3)] font-mono">
              {p.delivered} of {p.goalReached} offers delivered · {p.includedCampaigns} campaign
              {p.includedCampaigns === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] font-mono flex-wrap">
            <span className="text-red-400">no text sent: {pct(p.noSmsAmongGoal)} ({p.noSms})</span>
            <span className="text-amber-400">text failed: {pct(p.failedAmongGoal)} ({p.failed})</span>
            {p.inFlight > 0 && <span className="text-[var(--text-3)]">sent, not yet confirmed: {p.inFlight}</span>}
          </div>

          {allUnconfirmed && (
            <p className="text-[11px] text-amber-400/90">
              ⚠ None of these texts have a delivery confirmation yet. They show as &ldquo;sent&rdquo; but unconfirmed.
              That&apos;s usually a delivery-receipt gap (texts go out, receipts don&apos;t come back), not real failures.
            </p>
          )}

          {data.perCampaign.length > 0 && (
            <div className="border-t border-[var(--border)]">
              <div className="flex items-center gap-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-3)]">
                <span className="flex-1">campaign</span>
                <span className="font-mono">delivered / &ldquo;yes&rdquo;</span>
                <span className="w-10 text-right">rate</span>
              </div>
              <div className="divide-y divide-[var(--border)]">
                {data.perCampaign.slice(0, 8).map((c) => (
                  <div key={c.id} className="flex items-center gap-3 py-2 text-[11px]">
                    <span className="flex-1 min-w-0 truncate text-[var(--text-2)]">{c.name}</span>
                    <span className="text-[var(--text-3)] font-mono">
                      {c.delivered}/{c.goalReached}
                    </span>
                    <span
                      className={`font-semibold tabular-nums w-10 text-right ${
                        c.deliveredAmongGoal != null && c.deliveredAmongGoal < 0.5 ? "text-red-400" : "text-[var(--text-2)]"
                      }`}
                    >
                      {pct(c.deliveredAmongGoal)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </SectionIsland>
  );
}
