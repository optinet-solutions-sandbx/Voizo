"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  Phone,
  Pencil,
  PhoneCall,
  UserPlus,
  Search,
  Calendar,
  Download,
  Users,
} from "lucide-react";
import { initialCampaigns } from "@/lib/campaignData";
import { getContactsByCampaignId, ContactStatus } from "@/lib/contactData";
import StatusBadge from "@/components/StatusBadge";

// ── Contact status badge ────────────────────────────────────────────────────

const STATUS_STYLES: Record<ContactStatus, string> = {
  Unreached: "bg-amber-100 text-amber-700 border border-amber-200",
  Interested: "bg-green-100 text-green-700 border border-green-200",
  "Sent SMS": "bg-green-50 text-green-600 border border-green-200",
  "Declined Offer": "bg-yellow-100 text-yellow-700 border border-yellow-200",
  "Not interested": "bg-yellow-50 text-yellow-600 border border-yellow-200",
  "Do not call": "bg-pink-100 text-pink-700 border border-pink-200",
  "Pending Retry": "bg-pink-50 text-pink-600 border border-pink-200",
};

function ContactStatusBadge({ status }: { status: ContactStatus }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

// ── Progress bar segment colours ────────────────────────────────────────────

const STATUS_BAR_COLOR: Record<ContactStatus, string> = {
  Interested: "bg-green-500",
  "Sent SMS": "bg-green-400",
  "Declined Offer": "bg-yellow-400",
  "Not interested": "bg-yellow-300",
  "Do not call": "bg-pink-500",
  "Pending Retry": "bg-pink-300",
  Unreached: "bg-orange-400",
};

const STATUS_DOT_COLOR: Record<ContactStatus, string> = {
  Interested: "bg-green-500",
  "Sent SMS": "bg-green-400",
  "Declined Offer": "bg-yellow-400",
  "Not interested": "bg-yellow-300",
  "Do not call": "bg-pink-500",
  "Pending Retry": "bg-pink-300",
  Unreached: "bg-orange-400",
};

// Ordered for display consistency
const STATUS_ORDER: ContactStatus[] = [
  "Interested",
  "Sent SMS",
  "Declined Offer",
  "Not interested",
  "Do not call",
  "Pending Retry",
  "Unreached",
];

// ── Page ────────────────────────────────────────────────────────────────────

export default function CampaignDetailPage() {
  const params = useParams();
  const id = Number(params.id);

  const campaign = initialCampaigns.find((c) => c.id === id);

  if (!campaign) {
    return (
      <div className="p-6 flex flex-col gap-4">
        <p className="text-gray-500 text-sm">Campaign not found.</p>
        <Link
          href="/campaigns"
          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft size={14} />
          Back to Campaigns
        </Link>
      </div>
    );
  }

  const contactList = getContactsByCampaignId(id);

  // Count by status
  const statusCounts: Partial<Record<ContactStatus, number>> = {};
  for (const c of contactList) {
    statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  }
  const total = contactList.length || 1;

  // Active legend items
  const legendItems = STATUS_ORDER.filter((s) => (statusCounts[s] ?? 0) > 0);

  return (
    <div className="p-4 sm:p-6 w-full max-w-7xl mx-auto">
      {/* ── Back link ── */}
      <Link
        href="/campaigns"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 transition-colors mb-5"
      >
        <ArrowLeft size={14} />
        Back to Campaigns
      </Link>

      {/* ── Header row ── */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Icons */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="w-7 h-7 rounded bg-blue-50 flex items-center justify-center">
            <ArrowUpRight size={14} className="text-blue-500" />
          </span>
          <span className="w-7 h-7 rounded bg-gray-100 flex items-center justify-center">
            <Phone size={14} className="text-gray-500" />
          </span>
        </div>

        {/* Campaign name */}
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 leading-tight flex-1 min-w-0">
          {campaign.name}
        </h1>

        {/* Status */}
        <StatusBadge status={campaign.status} />

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors">
            <Pencil size={13} />
            Edit
          </button>
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors">
            <PhoneCall size={13} />
            Test Call
          </button>
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
            <UserPlus size={13} />
            Add Contact
          </button>
        </div>
      </div>

      {/* ── Stats section ── */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        {/* Left: contact progress */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-sm text-gray-500 font-medium">Total contacts:</span>
            <span className="text-3xl font-bold text-gray-900">{contactList.length}</span>
          </div>

          {/* Progress bar */}
          <div className="flex h-3 rounded-full overflow-hidden mb-3 gap-px bg-gray-100">
            {STATUS_ORDER.map((s) => {
              const count = statusCounts[s] ?? 0;
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={s}
                  className={`${STATUS_BAR_COLOR[s]} transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${s}: ${count}`}
                />
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {legendItems.map((s) => (
              <div key={s} className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT_COLOR[s]}`} />
                <span>{s}</span>
                <span className="font-semibold text-gray-800">{statusCounts[s]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: stats card */}
        <div className="w-full sm:w-56 bg-white rounded-xl border border-gray-200 p-4 shrink-0">
          <p className="text-sm font-semibold text-gray-700 mb-3">
            Total Calls:{" "}
            <span className="text-gray-900">{campaign.totalCalls.toLocaleString()}</span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500 mb-1">Connect Rate</p>
              <p className="text-lg font-bold text-gray-900">{campaign.connectRate}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
                <Users size={11} />
                <span>{campaign.connectCount}</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Success Rate</p>
              <p className="text-lg font-bold text-gray-900">{campaign.successRate}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
                <Users size={11} />
                <span>{campaign.successCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Contacts section ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 p-4 border-b border-gray-100">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search contacts..."
              className="w-full pl-9 pr-10 py-2 text-sm border border-gray-200 rounded-lg placeholder-gray-400 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            />
            <Calendar
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 cursor-pointer"
            />
          </div>
          <button className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors whitespace-nowrap shrink-0">
            <Download size={13} />
            Export contacts
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Name &amp; Phone Number
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  Attempts
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  Last Attempt
                </th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">
                  Call Duration
                </th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Status
                </th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Events
                </th>
              </tr>
            </thead>
            <tbody>
              {contactList.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-400">
                    No contacts found for this campaign.
                  </td>
                </tr>
              ) : (
                contactList.map((contact, index) => (
                  <tr
                    key={contact.id}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                      index === contactList.length - 1 ? "border-b-0" : ""
                    }`}
                  >
                    <td className="px-4 py-3 min-w-[200px]">
                      <p className="font-medium text-gray-900">{contact.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{contact.phone}</p>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{contact.attempts}</td>
                    <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                      {contact.lastAttempt}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                      {contact.callDuration}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <ContactStatusBadge status={contact.status} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button className="text-xs text-blue-600 hover:underline">View</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
