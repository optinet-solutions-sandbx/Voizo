"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Phone, ExternalLink, MoreHorizontal, Copy, Archive, RotateCcw, Trash2 } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { Campaign } from "@/lib/campaignData";

interface CampaignsTableProps {
  campaigns: Campaign[];
  onDuplicate?: (id: number) => void;
  onDelete?: (id: number) => void;
  onArchive?: (id: number) => void;
  onRecover?: (id: number) => void;
}

export default function CampaignsTable({ campaigns, onDuplicate, onArchive, onRecover, onDelete }: CampaignsTableProps) {
  const router = useRouter();
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenuId(null);
    }
    function handleScroll() { setOpenMenuId(null); }
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, []);

  if (campaigns.length === 0) {
    return (
      <div className="bg-[var(--bg-app)] px-6 py-16 text-center">
        <p className="text-[var(--text-3)] text-sm">No campaigns found.</p>
      </div>
    );
  }

  const openMenu = campaigns.find((c) => c.id === openMenuId);

  return (
    <>
      <div className="bg-[var(--bg-app)] w-full overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
              <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide w-16">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Campaign Name</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Total Contacts</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Total Calls</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Connect Rate</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Success Rate</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Status</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign, index) => (
              <tr key={campaign.id} onClick={() => router.push('/campaigns/' + campaign.id)}
                className={`group border-b border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer ${index === campaigns.length - 1 ? "border-b-0" : ""}`}>
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-1">
                    <span className="w-6 h-6 rounded-md bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <ArrowUpRight size={12} className="text-blue-400" />
                    </span>
                    <span className="w-6 h-6 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center flex-shrink-0">
                      <Phone size={12} className="text-[var(--text-2)]" />
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3.5 text-[var(--text-1)] font-medium min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="group-hover:text-blue-400 transition-colors">{campaign.name}</span>
                    {campaign.isDuplicate && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
                        Duplicate
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3.5 text-right text-[var(--text-2)] whitespace-nowrap">{campaign.totalContacts.toLocaleString()}</td>
                <td className="px-4 py-3.5 text-right whitespace-nowrap">
                  <span className={campaign.group === "Canada" ? "text-blue-400 font-medium" : "text-[var(--text-2)]"}>
                    {campaign.totalCalls.toLocaleString()}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right whitespace-nowrap">
                  <span className="text-[var(--text-2)]">{campaign.connectRate}</span>
                  <span className="text-[var(--text-3)] text-xs ml-1">({campaign.connectCount})</span>
                </td>
                <td className="px-4 py-3.5 text-right whitespace-nowrap">
                  <span className="text-[var(--text-2)]">{campaign.successRate}</span>
                  <span className="text-[var(--text-3)] text-xs ml-1">({campaign.successCount})</span>
                </td>
                <td className="px-4 py-3.5 text-center"><StatusBadge status={campaign.status} /></td>
                <td className="px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => router.push('/campaigns/' + campaign.id)}
                      className="p-1.5 text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-elevated)] rounded-md transition-colors" title="Open">
                      <ExternalLink size={14} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (openMenuId === campaign.id) { setOpenMenuId(null); }
                        else {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                          setOpenMenuId(campaign.id);
                        }
                      }}
                      className="p-1.5 text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-elevated)] rounded-md transition-colors" title="More">
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openMenuId !== null && openMenu && (
        <div ref={menuRef} style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
          className="z-50 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl py-1 min-w-[140px]">
          {openMenu.group === "Archived" ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); onRecover?.(openMenu.id); setOpenMenuId(null); }}
                className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition-colors">
                <RotateCcw size={14} className="text-[var(--text-2)]" /> Recover
              </button>
              <button onClick={(e) => { e.stopPropagation(); onDelete?.(openMenu.id); setOpenMenuId(null); }}
                className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors">
                <Trash2 size={14} className="text-red-500" /> Delete
              </button>
            </>
          ) : (
            <>
              <button onClick={(e) => { e.stopPropagation(); onDuplicate?.(openMenu.id); setOpenMenuId(null); }}
                className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition-colors">
                <Copy size={14} className="text-[var(--text-2)]" /> Duplicate
              </button>
              <button onClick={(e) => { e.stopPropagation(); onArchive?.(openMenu.id); setOpenMenuId(null); }}
                className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition-colors">
                <Archive size={14} className="text-[var(--text-2)]" /> Archive
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
