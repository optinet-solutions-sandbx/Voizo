"use client";

// Always-on campaigns control section (post-VOZ-132 ops, 2026-07-10).
//
// One row per recurring/real-time PARENT + its latest child, with the three
// controls the flat list can't offer:
//   1. Compound Stop — pauses the parent AND today's child together, killing
//      the parent/child footgun (child-only pause respawns tomorrow;
//      parent-only pause keeps dialing today; a DRAFT child would even
//      auto-start later unless flipped too).
//   2. Resume schedule — parent status flip (parents hold no clone/slot, so a
//      soft flip is the blessed path per the /status route).
//   3. Settings link — opens /campaigns/v2/[id]/edit, the single edit surface
//      (settings consolidation 2026-08-20; the inline drawer this section used
//      to carry duplicated that page and the two had drifted). Children copy
//      the parent at every spawn, so edits apply from tomorrow's campaign.
//
// Renders null when no running/paused recurring parents exist — the section
// is invisible in today's prod until the first one is created.

import { useState } from "react";
import Link from "next/link";
import { Building2, Loader2, Pause, Play, Repeat, Settings, Zap } from "lucide-react";
import { deriveAlwaysOnRows, type AlwaysOnRow } from "@/lib/alwaysOn";
import { brandLabel } from "@/lib/campaignDisplay";
import { updateCampaignV2Status } from "@/lib/campaignV2Client";

type CampaignRow = Record<string, unknown>;

interface Props {
  campaigns: CampaignRow[];
  /** The page's setCampaigns — local optimistic updates after actions. */
  onMutate: (updater: (prev: CampaignRow[]) => CampaignRow[]) => void;
  /** Per-campaign analytics (keyed by id) so a parent row can show today's
   *  child's contacted-of-players inline. Structural subset of CampaignAnalytics. */
  analytics?: Record<string, { reach: number; targeted: number }>;
}

export default function AlwaysOnSection({ campaigns, onMutate, analytics = {} }: Props) {
  const rows = deriveAlwaysOnRows(campaigns);
  const [actionId, setActionId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  if (rows.length === 0) return null;

  function localPatch(id: string, patch: Record<string, unknown>) {
    onMutate((prev) => prev.map((c) => ((c.id as string) === id ? { ...c, ...patch } : c)));
  }

  async function handleStopAlwaysOn(row: AlwaysOnRow) {
    const parent = row.parent;
    const child = row.latestChild;
    const childStatus = (child?.status as string) ?? null;
    const willStopChild = childStatus === "running" || childStatus === "draft";
    const ok = window.confirm(
      willStopChild
        ? "Stop this campaign? Today's calls stop and it won't run again until you resume."
        : "Stop this campaign? It won't run again until you resume.",
    );
    if (!ok) return;

    setActionId(parent.id as string);
    setRowError(null);
    try {
      // Parent first: the schedule is the thing being stopped; if the child
      // half fails we surface it, but tomorrow is already safe.
      await updateCampaignV2Status(parent.id as string, "paused");
      localPatch(parent.id as string, { status: "paused" });

      if (child && childStatus === "running") {
        // House kill for a live campaign: cancels queued work, in-flight
        // call ends naturally (~60s) — same action as the list's Stop.
        const res = await fetch(`/api/campaigns-v2/${child.id as string}/stop`, { method: "POST" });
        if (!res.ok && res.status !== 409) throw new Error(`Stopping today's run failed (${res.status})`);
        localPatch(child.id as string, { status: "paused" });
      } else if (child && childStatus === "draft") {
        // A draft child auto-starts at window-open INDEPENDENT of the parent —
        // it must be flipped too or "stopped" quietly un-stops itself today.
        await updateCampaignV2Status(child.id as string, "paused");
        localPatch(child.id as string, { status: "paused" });
      }
    } catch (err) {
      console.error("[always-on] stop failed:", err);
      setRowError({
        id: parent.id as string,
        message: err instanceof Error ? err.message : "Stop failed. Check the campaign pages.",
      });
    } finally {
      setActionId(null);
    }
  }

  async function handleResumeParent(parent: CampaignRow) {
    setActionId(parent.id as string);
    setRowError(null);
    try {
      await updateCampaignV2Status(parent.id as string, "running");
      localPatch(parent.id as string, { status: "running" });
    } catch (err) {
      console.error("[always-on] resume failed:", err);
      setRowError({
        id: parent.id as string,
        message: err instanceof Error ? err.message : "Resume failed.",
      });
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="rounded-2xl border-[1.5px] border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
      <div className="px-4 pt-3.5 pb-2.5">
        <div className="text-sm font-semibold text-[var(--text-1)]">Always-on campaigns</div>
        <p className="text-xs text-[var(--text-3)] mt-0.5">
          Stop ends today&apos;s calls and tomorrow&apos;s run. Settings changes start tomorrow.
        </p>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {rows.map((row) => {
          const parent = row.parent;
          const parentId = parent.id as string;
          const isRealtime = parent.realtime === true;
          const parentRunning = (parent.status as string) === "running";
          const child = row.latestChild;
          const childStatus = (child?.status as string) ?? null;
          const childStats = child ? analytics[child.id as string] : undefined;
          const busy = actionId === parentId;

          return (
            <div key={parentId} className="px-4 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold shrink-0 ${
                    isRealtime ? "bg-amber-500/15 text-amber-300" : "bg-blue-500/15 text-blue-300"
                  }`}
                >
                  {isRealtime ? <Zap size={11} /> : <Repeat size={11} />}
                  {isRealtime ? "Real-time" : "Repeat daily"}
                </span>

                <div className="min-w-0 flex-1">
                  {/* Brand beside the name (VOZ-216): two live parents can differ ONLY
                      by brand ("…REG YESTERDAY AU" exists for both Lucky7even and
                      Fortune Play), and this row carries Stop/Settings for a real
                      running campaign — the owner must be unmistakable before clicking. */}
                  <div className="flex items-center gap-2 min-w-0">
                    <Link
                      href={`/campaigns/v2/${parentId}`}
                      className="text-sm font-medium text-[var(--text-1)] hover:text-blue-400 transition truncate"
                    >
                      {(parent.name as string) ?? parentId}
                    </Link>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 text-[10px] shrink-0">
                      <Building2 size={10} /> {brandLabel(parent.cio_workspace as string | null)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-3)] mt-0.5 truncate">
                    {parentRunning ? (
                      <span className="text-emerald-400">Schedule live</span>
                    ) : (
                      <span>Schedule paused</span>
                    )}
                    {" · "}
                    {child ? (
                      <>
                        today&apos;s run:{" "}
                        <Link
                          href={`/campaigns/v2/${child.id as string}`}
                          className="underline decoration-dotted hover:text-[var(--text-2)]"
                        >
                          {childStatus}
                        </Link>
                        {childStats && childStats.targeted > 0 && (
                          <span className="text-[var(--text-2)]">
                            {" · "}
                            {childStats.reach.toLocaleString()} of {childStats.targeted.toLocaleString()} players contacted
                          </span>
                        )}
                        {childStatus === "paused" && parentRunning && (
                          <span> (resume it from its page)</span>
                        )}
                      </>
                    ) : (
                      <span>no run today yet</span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* Settings consolidation (2026-08-20): one edit surface. The inline
                      drawer duplicated /campaigns/v2/[id]/edit and the two had already
                      drifted (the drawer had the VOZ-245 mode picker, the page didn't). */}
                  <Link
                    href={`/campaigns/v2/${parentId}/edit`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:border-[var(--border-2)] transition"
                  >
                    <Settings size={12} />
                    Settings
                  </Link>
                  {parentRunning ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleStopAlwaysOn(row)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 transition disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                      Stop campaign
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleResumeParent(parent)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      Resume schedule
                    </button>
                  )}
                </div>
              </div>

              {rowError?.id === parentId && (
                <p className="text-[11px] text-red-400 mt-2">{rowError.message}</p>
              )}

            </div>
          );
        })}
      </div>
    </div>
  );
}
