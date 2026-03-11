"use client";

import { useState, useMemo } from "react";
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
  ChevronLeft,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { initialCampaigns } from "@/lib/campaignData";
import { getContactsByCampaignId, ContactStatus, Contact } from "@/lib/contactData";
import StatusBadge from "@/components/StatusBadge";

const PAGE_SIZE = 8;

// ── Contact status badge ─────────────────────────────────────────────────────

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
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

// ── Progress bar colours ──────────────────────────────────────────────────────

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

const STATUS_ORDER: ContactStatus[] = [
  "Interested",
  "Sent SMS",
  "Declined Offer",
  "Not interested",
  "Do not call",
  "Pending Retry",
  "Unreached",
];

// ── CSV export ────────────────────────────────────────────────────────────────

function exportToCSV(contacts: Contact[], filename: string) {
  const headers = ["Name", "Phone", "Attempts", "Last Attempt", "Call Duration", "Status"];
  const rows = contacts.map((c) => [
    c.name,
    c.phone,
    String(c.attempts),
    c.lastAttempt,
    c.callDuration,
    c.status,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CampaignDetailPage() {
  const params = useParams();
  const id = Number(params.id);

  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const campaign = initialCampaigns.find((c) => c.id === id);

  if (!campaign) {
    return (
      <div className="p-6 flex flex-col gap-4">
        <p className="text-gray-500 text-sm">Campaign not found.</p>
        <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
          <ArrowLeft size={14} />
          Back to Campaigns
        </Link>
      </div>
    );
  }

  const allContacts = getContactsByCampaignId(id);

  // Status counts for progress bar (all contacts)
  const statusCounts: Partial<Record<ContactStatus, number>> = {};
  for (const c of allContacts) {
    statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  }
  const totalContacts = allContacts.length || 1;
  const legendItems = STATUS_ORDER.filter((s) => (statusCounts[s] ?? 0) > 0);

  // Filtered by search
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allContacts;
    return allContacts.filter(
      (c) => c.name.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q)
    );
  }, [allContacts, searchQuery]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function handleSearch(q: string) {
    setSearchQuery(q);
    setCurrentPage(1);
  }

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Back link */}
      <Link
        href="/campaigns"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 transition-colors mb-5"
      >
        <ArrowLeft size={14} />
        Back to Campaigns
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex items-center gap-1 shrink-0">
          <span className="w-7 h-7 rounded bg-blue-50 flex items-center justify-center">
            <ArrowUpRight size={14} className="text-blue-500" />
          </span>
          <span className="w-7 h-7 rounded bg-gray-100 flex items-center justify-center">
            <Phone size={14} className="text-gray-500" />
          </span>
        </div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 leading-tight flex-1 min-w-0">
          {campaign.name}
        </h1>
        <StatusBadge status={campaign.status} />
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
          <button
            onClick={() => setShowDeleteModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-gray-200 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 hover:border-red-200 transition-colors"
            title="Archive campaign"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        {/* Contact progress */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-sm text-gray-500 font-medium">Total contacts:</span>
            <span className="text-3xl font-bold text-gray-900">{allContacts.length}</span>
          </div>
          <div className="flex h-3 rounded-full overflow-hidden mb-3 gap-px bg-gray-100">
            {STATUS_ORDER.map((s) => {
              const count = statusCounts[s] ?? 0;
              if (count === 0) return null;
              return (
                <div
                  key={s}
                  className={`${STATUS_BAR_COLOR[s]} transition-all`}
                  style={{ width: `${(count / totalContacts) * 100}%` }}
                  title={`${s}: ${count}`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {legendItems.map((s) => (
              <div key={s} className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT_COLOR[s]}`} />
                <span>{s}:</span>
                <span className="font-semibold text-gray-800">{statusCounts[s]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Stats card */}
        <div className="w-full sm:w-56 bg-white rounded-xl border border-gray-200 p-4 shrink-0">
          <p className="text-sm font-semibold text-gray-700 mb-3">
            Total Calls: <span className="text-gray-900">{campaign.totalCalls.toLocaleString()}</span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500 mb-1">Connect Rate</p>
              <p className="text-lg font-bold text-gray-900">{campaign.connectRate}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
                <Users size={11} /><span>{campaign.connectCount}</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Success Rate</p>
              <p className="text-lg font-bold text-gray-900">{campaign.successRate}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-gray-500">
                <Users size={11} /><span>{campaign.successCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Contacts table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 p-4 border-b border-gray-100">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search Contacts"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full pl-9 pr-10 py-2 text-sm border border-gray-200 rounded-lg placeholder-gray-400 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            />
            <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 cursor-pointer" />
          </div>
          <button
            onClick={() => exportToCSV(filtered, `${campaign.name}-contacts.csv`)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors whitespace-nowrap shrink-0"
          >
            <Download size={13} />
            Export contacts
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name &amp; Phone Number</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Attempts</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Last Attempt</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Call Duration</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Events</th>
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-sm text-gray-400">
                    {searchQuery ? "No contacts match your search." : "No contacts found for this campaign."}
                  </td>
                </tr>
              ) : (
                paginated.map((contact, index) => (
                  <tr
                    key={contact.id}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                      index === paginated.length - 1 ? "border-b-0" : ""
                    }`}
                  >
                    <td className="px-4 py-3 min-w-[200px]">
                      <p className="font-medium text-gray-900">{contact.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{contact.phone}</p>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{contact.attempts}</td>
                    <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">{contact.lastAttempt}</td>
                    <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">{contact.callDuration}</td>
                    <td className="px-4 py-3 text-center"><ContactStatusBadge status={contact.status} /></td>
                    <td className="px-4 py-3 text-center">
                      <button className="text-xs text-blue-600 hover:underline">View</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <p className="text-xs text-gray-500">
              Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} contacts
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={safePage === 1}
                className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={15} />
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  key={p}
                  onClick={() => setCurrentPage(p)}
                  className={`w-7 h-7 text-xs rounded-md font-medium transition-colors ${
                    p === safePage ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {p}
                </button>
              ))}
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
      {/* Archive confirmation modal */}
      {showDeleteModal && (
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
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 px-4 py-2.5 border border-gray-200 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 px-4 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-full text-sm font-medium transition-colors"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
