import type { LeakStage } from "@/lib/campaignAnalytics";

interface LeakTagProps {
  stage: LeakStage;
}

const MAP: Record<LeakStage, { label: string; cls: string; hint: string }> = {
  never_dialed: { label: "Never-dialed", cls: "bg-amber-500/12 text-amber-400 border-amber-500/30", hint: "Capacity/throughput: resume, extend, or add workers" },
  pre_dial_hygiene: { label: "List hygiene", cls: "bg-violet-500/12 text-violet-400 border-violet-500/30", hint: "Suppressed / removed / recently-called elsewhere" },
  reachability: { label: "Reachability", cls: "bg-red-500/12 text-red-400 border-red-500/30", hint: "Carrier / timezone / SIP: fix the trunk" },
  conversion: { label: "Conversion", cls: "bg-primary/12 text-primary border-primary/30", hint: "Script / offer / assistant review" },
  none: { label: "—", cls: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]", hint: "Below volume floor or no dominant leak" },
};

/** One-word biggest-leak triage tag. 'none' renders an em-dash. */
export default function LeakTag({ stage }: LeakTagProps) {
  if (stage === "none") return <span className="text-[var(--text-3)] text-[11px]">—</span>;
  const m = MAP[stage];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${m.cls}`} title={m.hint}>
      {m.label}
    </span>
  );
}
