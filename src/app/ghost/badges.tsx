// Presentational tier/status badges for GhostPortal. No client hooks — usable
// from both the server detail page and the client list island.
import type { GhostStatus, GhostTier } from "@/lib/ghost/ghostRunData";

export function TierBadge({ tier }: { tier: GhostTier }) {
  // Live = real calls + real money → "hot" amber. Test = sandboxed → slate.
  const cls =
    tier === "live"
      ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
      : "bg-slate-500/15 text-slate-300 border-slate-500/30";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide border ${cls}`}>
      {tier}
    </span>
  );
}

const STATUS_CLS: Record<GhostStatus, string> = {
  draft: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  scrubbing: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  ready: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  launching: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  launched: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-300 border-red-500/30",
};

export function StatusBadge({ status }: { status: GhostStatus }) {
  const cls = STATUS_CLS[status] ?? STATUS_CLS.draft;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold capitalize border ${cls}`}>
      {status}
    </span>
  );
}
