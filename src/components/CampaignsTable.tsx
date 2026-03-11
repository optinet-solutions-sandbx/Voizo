"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Phone, ExternalLink, MoreHorizontal, Copy } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { Campaign } from "@/lib/campaignData";

interface CampaignsTableProps {
  campaigns: Campaign[];
  onDuplicate?: (id: number) => void;
  onDelete?: (id: number) => void;
}

export default function CampaignsTable({ campaigns, onDuplicate }: CampaignsTableProps) {
  const router = useRouter();
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (campaigns.length === 0) {
    return (
      <div className="bg-white px-6 py-16 text-center">
        <p className="text-gray-400 text-sm">No campaigns found.</p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white w-full overflow-x-auto" ref={menuRef}>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Campaign Name</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Total Contacts</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Total Calls</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Connect Rate</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Success Rate</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign, index) => (
              <tr
                key={campaign.id}
                className={`group border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer ${
                  index === campaigns.length - 1 ? "border-b-0" : ""
                }`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <span className="w-6 h-6 rounded bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <ArrowUpRight size={12} className="text-blue-500" />
                    </span>
                    <span className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <Phone size={12} className="text-gray-500" />
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-900 font-medium hover:text-blue-600 transition-colors min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{campaign.name}</span>
                    {campaign.isDuplicate && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 border border-blue-200 shrink-0">
                        Duplicate
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                  {campaign.totalContacts.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <span className={campaign.group === "Canada" ? "text-blue-600 font-medium" : "text-gray-700"}>
                    {campaign.totalCalls.toLocaleString()}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <span className="text-gray-700">{campaign.connectRate}</span>
                  <span className="text-gray-400 text-xs ml-1">({campaign.connectCount})</span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <span className="text-gray-700">{campaign.successRate}</span>
                  <span className="text-gray-400 text-xs ml-1">({campaign.successCount})</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={campaign.status} />
                </td>
                {/* Actions */}
                <td className="px-3 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => router.push('/campaigns/' + campaign.id)}
                      className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                      title="Open"
                    >
                      <ExternalLink size={14} />
                    </button>
                    {/* More (Duplicate only) */}
                    <div className="relative">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(openMenuId === campaign.id ? null : campaign.id);
                        }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                        title="More options"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {openMenuId === campaign.id && (
                        <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-xl shadow-lg py-1 min-w-[140px]">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDuplicate?.(campaign.id);
                              setOpenMenuId(null);
                            }}
                            className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                          >
                            <Copy size={14} className="text-gray-400" />
                            Duplicate
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </>
  );
}
