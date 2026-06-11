"use client";

import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

// Re-fetches the server-rendered run view (force-dynamic) so the operator can
// watch progress advance without a full reload.
export default function RefreshButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.refresh()}
      title="Refresh progress"
      className="p-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-3)] hover:text-[var(--text-1)] transition"
    >
      <RefreshCw size={15} />
    </button>
  );
}
