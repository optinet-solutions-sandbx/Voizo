"use client";

import { ArrowUpRight, Phone } from "lucide-react";
import StatusBadge from "./StatusBadge";
import { Campaign } from "@/lib/campaignData";

interface CampaignsTableProps {
  campaigns: Campaign[];
}

export default function CampaignsTable({ campaigns }: CampaignsTableProps) {
  if (campaigns.length === 0) {
    return (
      <div className="bg-white px-6 py-16 text-center">
        <p className="text-gray-400 text-sm">No campaigns found.</p>
      </div>
    );
  }

  return (
    <>
      {/* ── Mobile card list (< md) ── */}
      <div className="md:hidden bg-white divide-y divide-gray-100">
        {campaigns.map((campaign) => (
          <div key={campaign.id} className="px-4 py-4 hover:bg-gray-50 transition-colors cursor-pointer">
            {/* Top: icons + name + status */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-6 h-6 rounded bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <ArrowUpRight size={11} className="text-blue-500" />
                </span>
                <span className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <Phone size={11} className="text-gray-500" />
                </span>
                <span className="text-sm font-medium text-gray-900 leading-snug line-clamp-2">
                  {campaign.name}
                </span>
              </div>
              <div className="flex-shrink-0 mt-0.5">
                <StatusBadge status={campaign.status} />
              </div>
            </div>
            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 pl-1">
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Total Contacts</p>
                <p className="text-sm font-medium text-gray-700">{campaign.totalContacts.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Total Calls</p>
                <p className={`text-sm font-medium ${campaign.group === "Canada" ? "text-blue-600" : "text-gray-700"}`}>
                  {campaign.totalCalls.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Connect Rate</p>
                <p className="text-sm text-gray-700">
                  {campaign.connectRate}
                  <span className="text-gray-400 text-xs ml-1">({campaign.connectCount})</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-400 mb-0.5">Success Rate</p>
                <p className="text-sm text-gray-700">
                  {campaign.successRate}
                  <span className="text-gray-400 text-xs ml-1">({campaign.successCount})</span>
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Desktop table (≥ md) ── */}
      <div className="hidden md:block bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Campaign name</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Contacts</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Total Calls</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Connect Rate</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Success Rate</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
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
                    <span className="w-6 h-6 rounded bg-blue-50 flex items-center justify-center">
                      <ArrowUpRight size={12} className="text-blue-500" />
                    </span>
                    <span className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center">
                      <Phone size={12} className="text-gray-500" />
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-900 font-medium hover:text-blue-600 transition-colors">
                  {campaign.name}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {campaign.totalContacts.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className={campaign.group === "Canada" ? "text-blue-600 font-medium" : "text-gray-700"}>
                    {campaign.totalCalls.toLocaleString()}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-gray-700">{campaign.connectRate}</span>
                  <span className="text-gray-400 text-xs ml-1">({campaign.connectCount})</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-gray-700">{campaign.successRate}</span>
                  <span className="text-gray-400 text-xs ml-1">({campaign.successCount})</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={campaign.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
