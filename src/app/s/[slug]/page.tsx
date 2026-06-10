import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Ghost, Phone } from "lucide-react";
import { ghostPortalEnabled } from "@/lib/ghost/ghostConfig";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { getGhostRunBySlug } from "@/lib/ghost/ghostRunData";
import { StatusBadge, TierBadge } from "../../ghost/badges";
import RefreshButton from "./RefreshButton";
import GhostRunReviews from "./GhostRunReviews";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GhostPortal run · Voizo",
  description: "Read-only view of a GhostPortal run and its campaign progress.",
};

// Read-only GhostPortal run view at a gated URL (/s/<slug>). Behind Basic Auth +
// GHOST_PORTAL_ENABLED. Ghost runs are excluded from /campaigns, so this is the
// operator's window into a run's progress. Loaded server-side (service role).
export const dynamic = "force-dynamic";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

export default async function GhostRunDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  if (!ghostPortalEnabled()) notFound();
  const { slug } = await params;

  const run = await getGhostRunBySlug(supabaseAdmin, slug);
  if (!run) notFound();

  // Live progress snapshot of the materialized campaign (if launched).
  let campaignStatus: string | null = null;
  let totalNumbers = 0;
  let callsPlaced = 0;
  let outcomeBreakdown: Array<{ outcome: string; count: number }> = [];
  if (run.campaign_id) {
    const [{ data: campaign }, totalRes, callsRes, outcomesRes] = await Promise.all([
      supabaseAdmin.from("campaigns_v2").select("status").eq("id", run.campaign_id).maybeSingle(),
      supabaseAdmin.from("campaign_numbers_v2").select("id", { count: "exact", head: true }).eq("campaign_id", run.campaign_id),
      supabaseAdmin.from("calls_v2").select("id", { count: "exact", head: true }).eq("campaign_id", run.campaign_id),
      supabaseAdmin.from("campaign_numbers_v2").select("outcome").eq("campaign_id", run.campaign_id).range(0, 1999),
    ]);
    campaignStatus = (campaign?.status as string) ?? null;
    totalNumbers = totalRes.count ?? 0;
    callsPlaced = callsRes.count ?? 0;
    const tally = new Map<string, number>();
    for (const r of outcomesRes.data ?? []) {
      const o = (r.outcome as string) ?? "pending";
      tally.set(o, (tally.get(o) ?? 0) + 1);
    }
    outcomeBreakdown = Array.from(tally.entries())
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count);
  }

  return (
    <div className="min-h-screen bg-[var(--bg-app)] text-[var(--text-1)]">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <Link href="/ghost" className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition mb-5">
          <ArrowLeft size={13} /> All runs
        </Link>

        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight inline-flex items-center gap-2">
              <Ghost size={20} className="text-violet-400" /> {run.name}
            </h1>
            <div className="flex items-center gap-2 mt-2">
              <TierBadge tier={run.tier} />
              <StatusBadge status={run.status} />
              <span className="text-[10px] text-[var(--text-3)] font-mono">{run.slug}</span>
            </div>
          </div>
          <RefreshButton />
        </div>

        {run.status === "failed" && run.fail_reason && (
          <div className="mb-5 px-4 py-3 rounded-xl bg-red-500/[0.08] border border-red-500/30 text-xs text-red-300">
            {run.fail_reason}
          </div>
        )}

        {/* Run summary */}
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 mb-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-3">Run</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
            <Info label="Operator" value={run.operator} />
            <Info label="Created" value={fmt(run.created_at)} />
            <Info label="Launched" value={fmt(run.launched_at)} />
            <Info label="Uploaded" value={String(run.uploaded_count)} tone="text-[var(--text-1)]" />
            <Info label="Net (dialed)" value={String(run.scrubbed_count)} tone="text-emerald-300" />
            <Info label="Suppressed" value={String(run.suppressed_count)} tone="text-amber-300" />
          </dl>
        </section>

        {/* Live campaign progress */}
        {run.campaign_id ? (
          <>
          <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)]">Progress (snapshot)</h2>
              {campaignStatus && <StatusBadgeRaw label={campaignStatus} />}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm mb-4">
              <Info label="Numbers" value={String(totalNumbers)} tone="text-[var(--text-1)]" />
              <Info label="Calls placed" value={String(callsPlaced)} tone="text-sky-300" />
            </div>
            {outcomeBreakdown.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {outcomeBreakdown.map((o) => (
                  <span key={o.outcome} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-xs">
                    <Phone size={11} className="text-[var(--text-3)]" />
                    <span className="text-[var(--text-2)] capitalize">{o.outcome.replace(/_/g, " ")}</span>
                    <span className="tabular-nums font-semibold text-[var(--text-1)]">{o.count}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="text-[10px] text-[var(--text-3)] mt-4">
              Dials run on the unchanged production pipeline. Refresh for the latest snapshot.
            </p>
          </section>
          <GhostRunReviews runId={run.id} />
          </>
        ) : (
          <section className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] p-8 text-center">
            <p className="text-sm text-[var(--text-2)]">Not launched yet</p>
            <p className="text-xs text-[var(--text-3)] mt-1">This run has no materialized campaign. Launch it from the runs list.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">{label}</dt>
      <dd className={`mt-0.5 ${tone ?? "text-[var(--text-2)]"} text-sm`}>{value}</dd>
    </div>
  );
}

function StatusBadgeRaw({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold capitalize border bg-[var(--bg-app)] text-[var(--text-2)] border-[var(--border)]">
      {label}
    </span>
  );
}
