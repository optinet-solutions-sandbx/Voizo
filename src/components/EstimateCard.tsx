"use client";

// Campaign cost estimator card (spec 2026-08-04 §6) — shared by the wizard
// PreviewRail and the campaign detail page. Fetches behavior+price rates once
// per (country, lineage) key, computes locally via the pure engine, and renders
// an expandable audit trail (native <details> — no custom state needed).

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Calculator } from "lucide-react";
import {
  estimateCampaign,
  type BehaviorRates,
  type EstimateInput,
} from "@/lib/campaignEstimate";
import type { PriceRates } from "@/lib/costRates";

interface RatesResponse {
  behavior: BehaviorRates;
  prices: PriceRates;
}

interface Props {
  input: EstimateInput;
  country: string | null;
  lineageParentId?: string | null;
  title?: string;
  /** Real-time framing: numbers are per-day at the daily cap. */
  perDayLabel?: boolean;
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}
function range(min: number, max: number, fmt: (n: number) => string): string {
  return `${fmt(min)} – ${fmt(max)}`;
}

export default function EstimateCard({
  input,
  country,
  lineageParentId,
  title = "Estimate",
  perDayLabel = false,
}: Props) {
  const [rates, setRates] = useState<RatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ratesKey = `${country ?? ""}|${lineageParentId ?? ""}`;
  useEffect(() => {
    let cancelled = false;
    setRates(null);
    setError(null);
    const qs = new URLSearchParams();
    if (country) qs.set("country", country);
    if (lineageParentId) qs.set("lineage", lineageParentId);
    fetch(`/api/campaigns-v2/estimate-rates?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<RatesResponse>;
      })
      .then((d) => {
        if (!cancelled) setRates(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(String(e.message ?? e));
      });
    return () => {
      cancelled = true;
    };
    // ratesKey is the composed dependency; country/lineage individually would re-fire identically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesKey]);

  const est = useMemo(
    () => (rates ? estimateCampaign(input, rates.behavior, rates.prices) : null),
    [rates, input],
  );

  const body = (() => {
    if (error) {
      return (
        <div className="text-[12px] text-red-400 leading-snug inline-flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>Estimate unavailable — {error}</span>
        </div>
      );
    }
    if (!rates || !est) {
      return <div className="text-[12px] text-[var(--text-3)]">Computing estimate…</div>;
    }
    if (est.totalPlayers === 0) {
      return (
        <div className="text-[12px] text-[var(--text-3)]">
          Add players to see cost and duration.
        </div>
      );
    }
    const p = rates.behavior.provenance;
    const unverified = !rates.prices.verified.vapi || !rates.prices.verified.openai;
    const suffix = perDayLabel ? " / day" : "";
    return (
      <>
        <div className="flex flex-col gap-1.5 text-[12px]">
          <Row
            label={`Expected dials${suffix}`}
            value={`~${Math.round(est.expectedDials.value).toLocaleString()}`}
          />
          <Row label={`Talk time${suffix}`} value={`~${(est.talkMinutes.value / 60).toFixed(1)} h`} />
          <Row
            label={`AI cost${suffix}`}
            value={`~${money(est.costTotal.value)}`}
            sub={`Vapi ${money(est.costVapi.value)} · OpenAI ${money(est.costOpenai.value)}`}
            strong
          />
          {est.durationDays && (
            <Row
              label="Duration"
              value={`${range(est.durationDays.min, est.durationDays.max, (n) => n.toFixed(1))} days`}
              sub="assumes typical concurrent load"
            />
          )}
        </div>
        {est.warnings.map((w) => (
          <div
            key={w}
            className="mt-2 text-[11px] text-amber-400 leading-snug inline-flex items-start gap-1.5"
          >
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}
        {unverified && (
          <div className="mt-2 text-[11px] text-amber-400 leading-snug inline-flex items-start gap-1.5">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <span>Rates pending verification against invoices.</span>
          </div>
        )}
        <div className="mt-2 text-[10px] text-[var(--text-3)]">
          Based on {p.sampleDials.toLocaleString()} calls · {p.windowFrom?.slice(0, 10)} →{" "}
          {p.windowTo?.slice(0, 10)} · {p.level} level
        </div>
        <details className="mt-2">
          <summary className="text-[11px] text-[var(--text-3)] cursor-pointer select-none">
            How is this computed?
          </summary>
          <div className="mt-2 flex flex-col gap-1.5 text-[11px] text-[var(--text-3)] leading-snug">
            <div>
              <b>Dials</b> {est.expectedDials.formula} →{" "}
              {Math.round(est.expectedDials.value).toLocaleString()} (bounds{" "}
              {Math.round(est.expectedDials.min).toLocaleString()}–
              {Math.round(est.expectedDials.max).toLocaleString()}, exact)
            </div>
            <div>
              <b>Talk</b> {est.talkMinutes.formula} → {est.talkMinutes.value.toFixed(0)} min
            </div>
            <div>
              <b>Vapi</b> {est.costVapi.formula}
              {rates.prices.verified.vapi ? "" : " — UNVERIFIED price"}
            </div>
            <div>
              <b>OpenAI</b> {est.costOpenai.formula}
              {rates.prices.verified.openai ? "" : " — UNVERIFIED price"}
            </div>
            {est.durationDays && (
              <div>
                <b>Duration</b> {est.durationDays.formula}
              </div>
            )}
            <div>
              <b>Rates basis</b> {rates.prices.basis}
            </div>
            <div>
              <b>Sample</b> {p.sampleDials.toLocaleString()} dials,{" "}
              {p.samplePlayers.toLocaleString()} players · level {p.level}
              {p.excludedDays.length > 0 && (
                <> · excluded unhealthy days: {p.excludedDays.join(", ")}</>
              )}
            </div>
            <div>
              <b>Behavior</b> connect {(rates.behavior.rConnect * 100).toFixed(1)}% · avg talk{" "}
              {rates.behavior.tTalkSec.toFixed(0)}s
              {rates.behavior.voicemailShare !== null && (
                <> (voicemail share {(rates.behavior.voicemailShare * 100).toFixed(0)}%)</>
              )}{" "}
              · resolve/attempt {(rates.behavior.p * 100).toFixed(1)}% · throughput p25/p50/p75{" "}
              {rates.behavior.dialsPerHourP25.toFixed(0)}/{rates.behavior.dialsPerHourP50.toFixed(0)}/
              {rates.behavior.dialsPerHourP75.toFixed(0)} dials/hr
            </div>
            <div>
              <b>Assumption</b> constant per-attempt resolution probability (truncated geometric);
              duration assumes typical concurrent load.
            </div>
          </div>
        </details>
      </>
    );
  })();

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-[18px]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold inline-flex items-center gap-1.5">
        <Calculator size={11} className="text-blue-400" /> {title}
      </div>
      <div className="mt-2">{body}</div>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[var(--text-3)]">{label}</span>
      <span className="text-right">
        <span className={`tabular-nums ${strong ? "font-bold text-[14px]" : "font-semibold"}`}>
          {value}
        </span>
        {sub && <span className="block text-[10px] text-[var(--text-3)]">{sub}</span>}
      </span>
    </div>
  );
}
