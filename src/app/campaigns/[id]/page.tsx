"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, ArrowUpRight, Phone, Pencil, PhoneCall, UserPlus,
  Search, Calendar, Download, Users, ChevronLeft, ChevronRight, Trash2, X,
  MoreHorizontal, ChevronDown,
} from "lucide-react";
import { fetchCampaigns, updateCampaignName, Campaign } from "@/lib/campaignData";
import { fetchContactsByCampaignId, insertContact, deleteContact, ContactStatus, Contact } from "@/lib/contactData";
import StatusBadge from "@/components/StatusBadge";

const PAGE_SIZE = 8;

// ── Status styles ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<ContactStatus, string> = {
  Unreached:        "bg-amber-500/10 text-amber-600 border border-amber-400/30",
  Interested:       "bg-emerald-500/10 text-emerald-600 border border-emerald-400/30",
  "Sent SMS":       "bg-emerald-500/10 text-emerald-600 border border-emerald-400/30",
  "Declined Offer": "bg-yellow-500/10 text-yellow-600 border border-yellow-400/30",
  "Not interested": "bg-yellow-500/10 text-yellow-600 border border-yellow-400/30",
  "Do not call":    "bg-red-500/10 text-red-500 border border-red-400/30",
  "Pending Retry":  "bg-pink-500/10 text-pink-500 border border-pink-400/30",
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
  Interested:       "bg-emerald-500",
  "Sent SMS":       "bg-emerald-400",
  "Declined Offer": "bg-yellow-400",
  "Not interested": "bg-yellow-300",
  "Do not call":    "bg-red-500",
  "Pending Retry":  "bg-pink-400",
  Unreached:        "bg-amber-400",
};

const STATUS_DOT_COLOR: Record<ContactStatus, string> = {
  Interested:       "bg-emerald-500",
  "Sent SMS":       "bg-emerald-400",
  "Declined Offer": "bg-yellow-400",
  "Not interested": "bg-yellow-300",
  "Do not call":    "bg-red-500",
  "Pending Retry":  "bg-pink-400",
  Unreached:        "bg-amber-400",
};

const STATUS_ORDER: ContactStatus[] = [
  "Interested", "Sent SMS", "Declined Offer", "Not interested",
  "Do not call", "Pending Retry", "Unreached",
];

// ── Attempt result options (for the status popover) ──────────────────────────

const ATTEMPT_RESULT_OPTIONS = [
  { label: "Interested",     color: "#10B981" },
  { label: "Email",          color: "#10B981" },
  { label: "Sent SMS",       color: "#10B981" },
  { label: "Not interested", color: "#F59E0B" },
  { label: "Declined Offer", color: "#F59E0B" },
  { label: "Voice mail",     color: "#F59E0B" },
  { label: "Call later",     color: "#F59E0B" },
];

// ── Simulate per-call history entries ────────────────────────────────────────

function generateAttempts(contact: Contact) {
  const results = ["Voice mail", "Voice mail", "Call later", "Voice mail", "Voice mail", "Voice mail", "Call later"];
  const durations = ["00:04", "00:05", "00:03", "00:04", "00:02", "00:03", "00:03"];
  const times = ["06:30 am", "06:30 am", "05:00 am", "03:30 am", "03:31 am", "06:30 am", "05:00 am"];
  const dates = ["Mar 2", "Mar 2", "Mar 2", "Mar 2", "Feb 28", "Feb 27", "Feb 27"];
  const count = Math.min(contact.attempts, 10);
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    date: dates[i % dates.length],
    time: times[i % times.length],
    duration: durations[i % durations.length],
    result: results[i % results.length],
  }));
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportToCSV(contacts: Contact[], filename: string) {
  const headers = ["Name", "Phone", "Attempts", "Last Attempt", "Call Duration", "Status"];
  const rows = contacts.map((c) => [c.name, c.phone, String(c.attempts), c.lastAttempt, c.callDuration, c.status]);
  const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CampaignDetailPage() {
  const params = useParams();
  const id = Number(params.id);

  const [campaign, setCampaign] = useState<Campaign | undefined>(undefined);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingPage, setLoadingPage] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [deleteContactId, setDeleteContactId] = useState<number | null>(null);

  // Side panel state
  const [selectedContactIdx, setSelectedContactIdx] = useState<number | null>(null);
  const [contactPanelTab, setContactPanelTab] = useState<"contact-info" | "call-attempts">("call-attempts");
  const [threeDotsOpen, setThreeDotsOpen] = useState(false);
  const [statusPopoverAttemptIdx, setStatusPopoverAttemptIdx] = useState<number | null>(null);
  const [attemptsHistoryOpen, setAttemptsHistoryOpen] = useState(true);
  const [attemptResults, setAttemptResults] = useState<Record<string, string>>({});
  const threeDotsRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([fetchCampaigns(), fetchContactsByCampaignId(id)])
      .then(([camps, ctcts]) => { setCampaign(camps.find((c) => c.id === id)); setContacts(ctcts); })
      .finally(() => setLoadingPage(false));
  }, [id]);

  // Close three dots on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (threeDotsRef.current && !threeDotsRef.current.contains(e.target as Node)) {
        setThreeDotsOpen(false);
      }
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setStatusPopoverAttemptIdx(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  if (loadingPage) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6 flex flex-col gap-4">
        <p className="text-[var(--text-2)] text-sm">Campaign not found.</p>
        <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors">
          <ArrowLeft size={14} /> Back to Campaigns
        </Link>
      </div>
    );
  }

  const statusCounts: Partial<Record<ContactStatus, number>> = {};
  for (const c of contacts) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  const totalContacts = contacts.length || 1;
  const legendItems = STATUS_ORDER.filter((s) => (statusCounts[s] ?? 0) > 0);

  const computedTotalCalls = contacts.reduce((sum, c) => sum + c.attempts, 0);
  const computedConnectCount = contacts.filter((c) => c.status !== "Unreached").length;
  const computedSuccessCount = contacts.filter((c) => c.status === "Interested" || c.status === "Sent SMS").length;
  const computedConnectRate = contacts.length > 0 ? ((computedConnectCount / contacts.length) * 100).toFixed(2) + "%" : "0%";
  const computedSuccessRate = computedConnectCount > 0 ? ((computedSuccessCount / computedConnectCount) * 100).toFixed(2) + "%" : "0%";

  const filtered = (() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q));
  })();

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const selectedContact = selectedContactIdx !== null ? filtered[selectedContactIdx] : null;
  const simulatedAttempts = selectedContact ? generateAttempts(selectedContact) : [];

  function openContactPanel(globalIdx: number) {
    setSelectedContactIdx(globalIdx);
    setContactPanelTab("call-attempts");
    setThreeDotsOpen(false);
    setStatusPopoverAttemptIdx(null);
    setAttemptsHistoryOpen(true);
  }

  function closeContactPanel() {
    setSelectedContactIdx(null);
    setThreeDotsOpen(false);
    setStatusPopoverAttemptIdx(null);
  }

  function handleSearch(q: string) { setSearchQuery(q); setCurrentPage(1); }

  async function handleSaveEdit() {
    if (editName.trim() && campaign) {
      setCampaign({ ...campaign, name: editName.trim() });
      try { await updateCampaignName(campaign.id, editName.trim()); } catch { /* UI updated */ }
    }
    setShowEdit(false);
  }

  async function handleAddContact() {
    if (!addName.trim() || !addPhone.trim()) return;
    const draft: Omit<Contact, "id"> = { campaignId: id, name: addName.trim(), phone: addPhone.trim(), attempts: 0, lastAttempt: "-", callDuration: "-", status: "Unreached" };
    try { const saved = await insertContact(draft); setContacts((prev) => [saved, ...prev]); }
    catch { setContacts((prev) => [{ ...draft, id: Date.now() }, ...prev]); }
    setAddName(""); setAddPhone(""); setShowAdd(false);
  }

  async function handleDeleteContact(contactId: number) {
    setContacts((prev) => prev.filter((c) => c.id !== contactId));
    if (selectedContact?.id === contactId) closeContactPanel();
    setDeleteContactId(null);
    try { await deleteContact(contactId); } catch { /* UI updated */ }
  }

  function handleArchiveContact() {
    if (!selectedContact) return;
    setContacts((prev) => prev.filter((c) => c.id !== selectedContact.id));
    closeContactPanel();
    setThreeDotsOpen(false);
  }

  // ── Attempt result badge style ──────────────────────────────────────────────
  function attemptBadgeStyle(result: string) {
    if (result === "Interested" || result === "Email" || result === "Sent SMS")
      return "bg-emerald-50 text-emerald-600 border border-emerald-200";
    if (result === "Call later")
      return "bg-orange-50 text-orange-500 border border-orange-200";
    return "bg-amber-50 text-amber-600 border border-amber-200"; // Voice mail, etc.
  }

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Back */}
      <Link href="/campaigns"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-2)] hover:text-blue-400 transition-colors mb-5">
        <ArrowLeft size={14} /> Back to Campaigns
      </Link>

      {/* Header */}
      <div className="mb-6">
        {/* Title row */}
        <div className="flex items-start gap-2 mb-3">
          <div className="flex items-center gap-1 shrink-0 mt-1">
            <span className="w-7 h-7 rounded-md bg-blue-500/10 flex items-center justify-center">
              <ArrowUpRight size={13} className="text-blue-400" />
            </span>
            <span className="w-7 h-7 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center">
              <Phone size={13} className="text-[var(--text-2)]" />
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-1)] leading-tight flex-1 min-w-0">
            {campaign.name}
          </h1>
        </div>
        {/* Actions row */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={campaign.status} />
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <button onClick={() => { setEditName(campaign.name); setShowEdit(true); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-[var(--border)] rounded-lg text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
              <Pencil size={13} /> Edit
            </button>
            <button className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-[var(--border)] rounded-lg text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
              <PhoneCall size={13} /> Test Call
            </button>
            <button onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors shadow-md shadow-blue-600/20">
              <UserPlus size={13} /><span className="hidden sm:inline">Add Contact</span><span className="sm:hidden">Add</span>
            </button>
          </div>
        </div>
      </div>

      {/* Stats cards */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1 bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-sm text-[var(--text-2)] font-medium">Total contacts:</span>
            <span className="text-3xl font-bold text-[var(--text-1)]">{contacts.length}</span>
          </div>
          <div className="flex h-2.5 rounded-full overflow-hidden mb-3 gap-px bg-[var(--bg-elevated)]">
            {STATUS_ORDER.map((s) => {
              const count = statusCounts[s] ?? 0;
              if (count === 0) return null;
              return (
                <div key={s} className={`${STATUS_BAR_COLOR[s]} transition-all`}
                  style={{ width: `${(count / totalContacts) * 100}%` }} title={`${s}: ${count}`} />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {legendItems.map((s) => (
              <div key={s} className="flex items-center gap-1.5 text-xs text-[var(--text-2)]">
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[s]}`} />
                <span>{s}:</span>
                <span className="font-semibold text-[var(--text-1)]">{statusCounts[s]}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="w-full sm:w-56 bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4 shrink-0">
          <p className="text-sm font-semibold text-[var(--text-2)] mb-3">
            Total Interactions: <span className="text-[var(--text-1)]">{computedTotalCalls.toLocaleString()}</span>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-[var(--text-3)] mb-1">Connect Rate</p>
              <p className="text-lg font-bold text-[var(--text-1)]">{computedConnectRate}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-[var(--text-3)]">
                <Users size={11} /><span>{computedConnectCount}</span>
              </div>
            </div>
            <div>
              <p className="text-xs text-[var(--text-3)] mb-1">Success Rate</p>
              <p className="text-lg font-bold text-[var(--text-1)]">{computedSuccessRate}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-[var(--text-3)]">
                <Users size={11} /><span>{computedSuccessCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Table + Side Panel flex layout */}
      <div className="flex gap-4 items-start relative">
        {/* Contacts table */}
        <div className={`bg-[var(--bg-app)] rounded-xl border border-[var(--border)] overflow-hidden transition-all ${selectedContact ? "flex-1 min-w-0" : "w-full"}`}>
          {/* Toolbar */}
          <div className="flex items-center gap-3 p-4 border-b border-[var(--border)] bg-[var(--bg-card)]">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <input type="text" placeholder="Search Contacts" value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                className="w-full pl-9 pr-10 py-2 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg placeholder-[var(--text-3)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
              />
              <Calendar size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] cursor-pointer" />
            </div>
            <button onClick={() => exportToCSV(filtered, `${campaign.name}-contacts.csv`)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-[var(--border)] rounded-lg text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors whitespace-nowrap shrink-0">
              <Download size={13} /> Export contacts
            </button>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px] text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Name &amp; Phone Number</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Attempts</th>
                  {!selectedContact && <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Last Attempt</th>}
                  {!selectedContact && <th className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide whitespace-nowrap">Call Duration</th>}
                  <th className="text-center px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Status</th>
                  {!selectedContact && <th className="px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Events</th>}
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {paginated.length === 0 ? (
                  <tr>
                    <td colSpan={selectedContact ? 4 : 7} className="px-4 py-12 text-center text-sm text-[var(--text-3)]">
                      {searchQuery ? "No contacts match your search." : "No contacts found for this campaign."}
                    </td>
                  </tr>
                ) : paginated.map((contact, pageIdx) => {
                  const globalIdx = (safePage - 1) * PAGE_SIZE + pageIdx;
                  const isSelected = selectedContact?.id === contact.id;
                  return (
                    <tr key={contact.id}
                      onClick={() => openContactPanel(globalIdx)}
                      className={`group border-b border-[var(--border)] cursor-pointer transition-colors ${isSelected ? "bg-blue-50/50" : "hover:bg-[var(--bg-hover)]"} ${pageIdx === paginated.length - 1 ? "border-b-0" : ""}`}>
                      <td className="px-4 py-3.5 min-w-[160px]">
                        <p className="font-medium text-[var(--text-1)]">{contact.name}</p>
                        <p className="text-xs text-[var(--text-3)] mt-0.5">{contact.phone}</p>
                      </td>
                      <td className="px-4 py-3.5 text-right text-[var(--text-2)]">{contact.attempts}</td>
                      {!selectedContact && <td className="px-4 py-3.5 text-right text-[var(--text-2)] whitespace-nowrap">{contact.lastAttempt}</td>}
                      {!selectedContact && <td className="px-4 py-3.5 text-right text-[var(--text-2)] whitespace-nowrap">{contact.callDuration}</td>}
                      <td className="px-4 py-3.5 text-center"><ContactStatusBadge status={contact.status} /></td>
                      {!selectedContact && <td className="px-4 py-3.5 text-[var(--text-3)] text-xs"></td>}
                      <td className="px-2 py-3.5 text-center">
                        <button onClick={(e) => { e.stopPropagation(); setDeleteContactId(contact.id); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 text-[var(--text-3)] hover:text-red-400 hover:bg-red-500/10 rounded-md"
                          title="Remove contact">
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-card)]">
              <p className="text-xs text-[var(--text-3)]">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} contacts
              </p>
              <div className="flex items-center gap-1">
                <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}
                  className="p-1.5 rounded-md text-[var(--text-3)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  <ChevronLeft size={15} />
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <button key={p} onClick={() => setCurrentPage(p)}
                    className={`w-7 h-7 text-xs rounded-md font-medium transition-colors ${
                      p === safePage ? "bg-blue-600 text-white shadow-md shadow-blue-600/20" : "text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)]"
                    }`}>
                    {p}
                  </button>
                ))}
                <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                  className="p-1.5 rounded-md text-[var(--text-3)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Contact side panel (mobile: full-screen overlay, desktop: side panel) ── */}
        {selectedContact && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:z-auto md:w-[460px] md:shrink-0 bg-white md:border md:border-gray-200 md:rounded-xl md:shadow-lg overflow-hidden flex flex-col" style={{ maxHeight: "100dvh" }}>

            {/* Previous / Next nav */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
              <button
                onClick={() => { if (selectedContactIdx !== null && selectedContactIdx > 0) openContactPanel(selectedContactIdx - 1); }}
                disabled={selectedContactIdx === 0}
                className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                <ChevronLeft size={15} /> Previous
              </button>
              <button
                onClick={() => { if (selectedContactIdx !== null && selectedContactIdx < filtered.length - 1) openContactPanel(selectedContactIdx + 1); }}
                disabled={selectedContactIdx === filtered.length - 1}
                className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                Next <ChevronRight size={15} />
              </button>
            </div>

            {/* Contact header */}
            <div className="px-5 pt-4 pb-3 border-b border-gray-100">
              <div className="flex items-start justify-between gap-2 mb-1">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{selectedContact.name}</h2>
                  <p className="text-sm text-gray-500 mt-0.5">{selectedContact.phone}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                  <ContactStatusBadge status={selectedContact.status} />
                  {/* Three dots */}
                  <div className="relative" ref={threeDotsRef}>
                    <button onClick={() => setThreeDotsOpen(!threeDotsOpen)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                      <MoreHorizontal size={16} />
                    </button>
                    {threeDotsOpen && (
                      <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-50 py-1 min-w-[160px]">
                        <button onClick={handleArchiveContact}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors">
                          <Trash2 size={14} /> Archive Contact
                        </button>
                      </div>
                    )}
                  </div>
                  <button onClick={closeContactPanel}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                    <X size={16} />
                  </button>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100 px-4">
              {(["contact-info", "call-attempts"] as const).map((tab) => (
                <button key={tab} onClick={() => setContactPanelTab(tab)}
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors mr-2 ${
                    contactPanelTab === tab
                      ? "border-gray-900 text-gray-900"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}>
                  {tab === "contact-info" ? "Contact Info" : "Call Attempts"}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>

              {/* Contact Info tab */}
              {contactPanelTab === "contact-info" && (
                <div className="divide-y divide-gray-100">
                  {[
                    { label: "Name", value: selectedContact.name },
                    { label: "Phone Number", value: selectedContact.phone },
                    { label: "Registered_at", value: selectedContact.registeredAt ?? "-" },
                    { label: "Timezone", value: selectedContact.timezone ?? "-" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex items-center justify-between px-5 py-3.5 bg-gray-50/60">
                      <span className="text-sm font-medium text-gray-600">{label}</span>
                      <span className="text-sm text-gray-900 text-right max-w-[55%]">{value}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Call Attempts tab */}
              {contactPanelTab === "call-attempts" && (
                <div className="px-5 py-4">
                  {/* Attempts history accordion */}
                  <button onClick={() => setAttemptsHistoryOpen(!attemptsHistoryOpen)}
                    className="w-full flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold text-gray-800">Attempts history</span>
                    <ChevronDown size={16} className="text-gray-400 transition-transform" style={{ transform: attemptsHistoryOpen ? "rotate(180deg)" : "rotate(0deg)" }} />
                  </button>

                  {attemptsHistoryOpen && (
                    <div className="flex flex-col gap-0">
                      {simulatedAttempts.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-6">No call attempts yet.</p>
                      ) : simulatedAttempts.map((attempt) => {
                        const attemptKey = `${selectedContact.id}-${attempt.id}`;
                        const currentResult = attemptResults[attemptKey] ?? attempt.result;
                        return (
                          <div key={attempt.id} className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0">
                            {/* Radio */}
                            <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${attempt.id === 0 ? "border-gray-800" : "border-gray-300"}`}>
                              {attempt.id === 0 && <div className="w-1.5 h-1.5 rounded-full bg-gray-800" />}
                            </div>
                            {/* Date + time + phone icon */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-800">{attempt.date}</p>
                              <div className="flex items-center gap-1 mt-0.5">
                                <span className="text-xs text-gray-400">{attempt.time}</span>
                                <Phone size={10} className="text-gray-400" />
                              </div>
                            </div>
                            {/* Waveform + duration */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
                                <rect x="0" y="4" width="2" height="6" rx="1" fill="#9CA3AF"/>
                                <rect x="4" y="2" width="2" height="10" rx="1" fill="#9CA3AF"/>
                                <rect x="8" y="0" width="2" height="14" rx="1" fill="#9CA3AF"/>
                                <rect x="12" y="2" width="2" height="10" rx="1" fill="#9CA3AF"/>
                                <rect x="16" y="4" width="2" height="6" rx="1" fill="#9CA3AF"/>
                              </svg>
                              <span className="text-xs text-gray-500 font-mono">{attempt.duration}</span>
                            </div>
                            {/* Status badge with popover */}
                            <div className="relative shrink-0" ref={statusPopoverAttemptIdx === attempt.id ? popoverRef : undefined}>
                              <button
                                onClick={() => setStatusPopoverAttemptIdx(statusPopoverAttemptIdx === attempt.id ? null : attempt.id)}
                                className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${attemptBadgeStyle(currentResult)}`}>
                                {currentResult}
                              </button>
                              {statusPopoverAttemptIdx === attempt.id && (
                                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-xl z-50 py-1.5 min-w-[170px]">
                                  {ATTEMPT_RESULT_OPTIONS.map((opt) => (
                                    <button key={opt.label}
                                      onClick={() => {
                                        setAttemptResults((prev) => ({ ...prev, [attemptKey]: opt.label }));
                                        setStatusPopoverAttemptIdx(null);
                                      }}
                                      className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors">
                                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${currentResult === opt.label ? "border-gray-800" : "border-gray-300"}`}>
                                        {currentResult === opt.label && <div className="w-1.5 h-1.5 rounded-full bg-gray-800" />}
                                      </div>
                                      <span className="text-sm font-medium" style={{ color: opt.color }}>{opt.label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Edit Campaign Modal */}
      {showEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-[var(--text-1)]">Edit Campaign</h2>
              <button onClick={() => setShowEdit(false)} className="p-1 text-[var(--text-2)] hover:text-[var(--text-1)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors">
                <X size={16} />
              </button>
            </div>
            <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">Campaign Name</label>
            <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveEdit()} autoFocus
              className="w-full px-3 py-2.5 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 mb-5 transition-all"
            />
            <div className="flex gap-3">
              <button onClick={() => setShowEdit(false)}
                className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
                Cancel
              </button>
              <button onClick={handleSaveEdit}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-full text-sm font-medium transition-colors shadow-md shadow-blue-600/20">
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Contact Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-[var(--text-1)]">Add Contact</h2>
              <button onClick={() => setShowAdd(false)} className="p-1 text-[var(--text-2)] hover:text-[var(--text-1)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors">
                <X size={16} />
              </button>
            </div>
            <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">Full Name</label>
            <input type="text" placeholder="e.g. John Smith" value={addName}
              onChange={(e) => setAddName(e.target.value)} autoFocus
              className="w-full px-3 py-2.5 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 mb-3 transition-all"
            />
            <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">Phone Number</label>
            <input type="text" placeholder="e.g. +1 555 123 4567" value={addPhone}
              onChange={(e) => setAddPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddContact()}
              className="w-full px-3 py-2.5 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 mb-5 transition-all"
            />
            <div className="flex gap-3">
              <button onClick={() => setShowAdd(false)}
                className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
                Cancel
              </button>
              <button onClick={handleAddContact} disabled={!addName.trim() || !addPhone.trim()}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-full text-sm font-medium transition-colors shadow-md shadow-blue-600/20">
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Contact Modal */}
      {deleteContactId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
            <div className="w-11 h-11 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <Trash2 size={18} className="text-red-400" />
            </div>
            <h2 className="text-base font-semibold text-[var(--text-1)] mb-2">Remove this contact?</h2>
            <p className="text-sm text-[var(--text-2)] mb-6 leading-relaxed">
              This contact will be permanently removed from the campaign and cannot be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteContactId(null)}
                className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
                Cancel
              </button>
              <button onClick={() => handleDeleteContact(deleteContactId)}
                className="flex-1 px-4 py-2.5 bg-red-500/90 hover:bg-red-500 text-white rounded-full text-sm font-medium transition-colors">
                Yes, Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
