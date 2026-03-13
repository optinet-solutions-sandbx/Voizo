"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Campaign, Group, Status } from "@/lib/campaignData";

interface Props {
  onClose: () => void;
  onAdd: (campaign: Campaign) => void;
  nextId: number;
  availableGroups: Group[];
}

const STATUSES: Status[] = ["Active", "Paused", "Stopped"];

export default function NewCampaignModal({ onClose, onAdd, nextId, availableGroups }: Props) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState<Group>(availableGroups[0] ?? "RND");
  const [status, setStatus] = useState<Status>("Active");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Campaign name is required."); return; }
    onAdd({ id: nextId, name: name.trim(), totalContacts: 0, totalCalls: 0, connectRate: "0%", connectCount: 0, successRate: "0%", successCount: 0, status, group });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-[var(--text-1)]">New Campaign</h2>
          <button onClick={onClose} className="p-1 text-[var(--text-2)] hover:text-[var(--text-1)] transition-colors rounded-lg hover:bg-[var(--bg-elevated)]">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">
              Campaign Name <span className="text-red-400">*</span>
            </label>
            <input type="text" value={name}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              placeholder="e.g. Lucky7even Promo v3"
              className="w-full px-3 py-2.5 bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
            />
            {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">Group</label>
            <select value={group} onChange={(e) => setGroup(e.target.value as Group)}
              className="w-full px-3 py-2.5 bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all">
              {availableGroups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as Status)}
              className="w-full px-3 py-2.5 bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-xl text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
              Cancel
            </button>
            <button type="submit"
              className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition-colors shadow-md shadow-blue-600/20">
              Create Campaign
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
