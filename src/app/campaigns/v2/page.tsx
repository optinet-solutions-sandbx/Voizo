"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Sparkles, Loader2 } from "lucide-react";
import { fetchCampaignsV2 } from "@/lib/campaignV2Data";
import { supabase } from "@/lib/supabase";

type CampaignRow = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-500/15 text-gray-400 border-gray-500/25",
    running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    paused: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    completed: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    archived: "bg-gray-500/15 text-gray-400 border-gray-500/25",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${map[status] ?? map.draft}`}>
      {status}
    </span>
  );
}

export default function CampaignsV2ListPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [stats, setStats] = useState<Record<string, { total: number; completed: number }>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const rows = await fetchCampaignsV2();
        setCampaigns(rows);

        // Fetch number stats per campaign
        const ids = rows.map((r: CampaignRow) => r.id as string);
        if (ids.length > 0) {
          const { data: numbers } = await supabase
            .from("campaign_numbers_v2")
            .select("campaign_id, outcome")
            .in("campaign_id", ids);

          const s: Record<string, { total: number; completed: number }> = {};
          for (const n of numbers ?? []) {
            const cid = n.campaign_id as string;
            if (!s[cid]) s[cid] = { total: 0, completed: 0 };
            s[cid].total++;
            if (n.outcome !== "pending") s[cid].completed++;
          }
          setStats(s);
        }
      } catch (err) {
        console.error("Failed to fetch campaigns:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-2)] hover:text-blue-400 transition-colors mb-3">
            <ArrowLeft size={14} /> Back to Campaigns
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
              <Sparkles size={18} className="text-blue-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-[var(--text-1)]">Campaigns V2</h1>
              <p className="text-sm text-[var(--text-3)] mt-1">Prompt-based outbound campaigns</p>
            </div>
          </div>
        </div>
        <Link
          href="/campaigns/v2/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors shadow-md shadow-blue-600/20"
        >
          <Plus size={15} /> New Campaign V2
        </Link>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-[var(--text-3)]">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading...
          </div>
        ) : campaigns.length === 0 ? (
          <div className="text-center py-16 text-[var(--text-3)] text-sm">
            No campaigns yet. Create your first one.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-3)] text-xs uppercase tracking-wide">
                <th className="text-left px-5 py-3 font-semibold">Name</th>
                <th className="text-left px-5 py-3 font-semibold">Agent</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-5 py-3 font-semibold">Numbers</th>
                <th className="text-left px-5 py-3 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const s = stats[c.id as string] ?? { total: 0, completed: 0 };
                return (
                  <tr key={c.id as string} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors">
                    <td className="px-5 py-3">
                      <Link href={`/campaigns/v2/${c.id}`} className="text-[var(--text-1)] font-medium hover:text-blue-400 transition-colors">
                        {c.name as string}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{(c.vapi_assistant_name as string) || "—"}</td>
                    <td className="px-5 py-3"><StatusBadge status={c.status as string} /></td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{s.completed}/{s.total}</td>
                    <td className="px-5 py-3 text-[var(--text-3)]">{new Date(c.created_at as string).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
