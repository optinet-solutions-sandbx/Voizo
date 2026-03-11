"use client";

import { useState, useEffect, useRef } from "react";
import { ArrowUpRight, Phone, ExternalLink, MoreHorizontal, Copy, Archive } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { Campaign } from "@/lib/campaignData";

interface CampaignsTableProps {
  campaigns: Campaign[];
  onDuplicate?: (id: number) => void;
  onDelete?: (id: number) => void;
}

export default function CampaignsTable({ campaigns, onDuplicate, onDelete }: CampaignsTableProps) {
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
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

  const deleteTarget = campaigns.find((c) => c.id === deleteConfirmId);

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
                className={`border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer ${
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
                  {campaign.name}
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
                      className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                      title="Open"
                    >
                      <ExternalLink size={14} />
                    </button>
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirmId(campaign.id);
                              setOpenMenuId(null);
                            }}
                            className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
                          >
                            <Archive size={14} />
                            Archive
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

      {/* Delete confirmation modal */}
      {deleteConfirmId && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
            <h2 className="text-base font-semibold text-gray-900 mb-2">
              Are you sure you want to delete this campaign?
            </h2>
            <p className="text-sm text-gray-400 mb-6 leading-relaxed">
              This action will remove all associated information permanently. This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirmId(null)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDelete?.(deleteConfirmId);
                  setDeleteConfirmId(null);
                }}
                className="flex-1 px-4 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-full text-sm font-medium transition-colors"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
