import { CheckCircle } from "lucide-react";

type Status = "Completed" | "Stopped" | "Active" | "Paused";

interface StatusBadgeProps {
  status: Status;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  if (status === "Completed") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-blue-500/20 text-blue-400 bg-blue-500/10">
        <CheckCircle size={11} /> Completed
      </span>
    );
  }
  if (status === "Stopped") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
        Stopped
      </span>
    );
  }
  if (status === "Active") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Active
      </span>
    );
  }
  if (status === "Paused") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-2)] border border-[var(--border)]">
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--bg-elevated)] text-[var(--text-2)]">
      {status}
    </span>
  );
}
