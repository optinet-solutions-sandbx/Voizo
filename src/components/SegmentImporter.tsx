"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Search, Users } from "lucide-react";

interface Segment {
  id: number;
  name: string;
  type: string;
}

interface Member {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

interface Props {
  onImport: (phones: string[]) => void;
}

export default function SegmentImporter({ onImport }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);
  const [selectedSegmentName, setSelectedSegmentName] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || segments !== null) return;
    (async () => {
      try {
        const res = await fetch("/api/customerio/segments");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setSegmentsError(body.error || `Failed to load segments (${res.status})`);
          return;
        }
        const body = await res.json();
        setSegments(body.segments ?? []);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : "Network error");
      }
    })();
  }, [expanded, segments]);

  const filteredSegments = useMemo(() => {
    if (!segments) return [];
    const term = search.trim().toLowerCase();
    const list = term
      ? segments.filter((s) => s.name.toLowerCase().includes(term))
      : segments;
    return list.slice(0, 50);
  }, [segments, search]);

  async function loadMembers(segmentId: number, segmentName: string) {
    setSelectedSegmentId(segmentId);
    setSelectedSegmentName(segmentName);
    setMembers(null);
    setMembersError(null);
    setMembersLoading(true);
    try {
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=50`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setMembersError(body.error || `Failed to load members (${res.status})`);
        return;
      }
      const body = await res.json();
      setMembers(body.members ?? []);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Network error");
    } finally {
      setMembersLoading(false);
    }
  }

  function handleImport() {
    if (!members) return;
    const phones = members
      .map((m) => m.phone)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (phones.length === 0) return;
    onImport(phones);
    setExpanded(false);
    setSelectedSegmentId(null);
    setSelectedSegmentName(null);
    setMembers(null);
    setSearch("");
  }

  const membersWithPhone = members?.filter((m) => m.phone) ?? [];

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] overflow-hidden">
      {/* Header toggle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
          <Users size={14} className="text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--text-1)]">Import from Customer.io</p>
          {selectedSegmentName && !expanded ? (
            <p className="text-xs text-indigo-400 truncate">{selectedSegmentName}</p>
          ) : (
            <p className="text-xs text-[var(--text-3)]">Select a segment to import phone numbers</p>
          )}
        </div>
        {expanded ? (
          <ChevronDown size={16} className="text-[var(--text-3)] flex-shrink-0" />
        ) : (
          <ChevronRight size={16} className="text-[var(--text-3)] flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-4">
          {/* Loading */}
          {segments === null && !segmentsError && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--text-3)]">
              <Loader2 size={14} className="animate-spin" />
              Loading segments...
            </div>
          )}

          {/* Error */}
          {segmentsError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {segmentsError}
            </div>
          )}

          {segments && (
            <div className="grid gap-3">
              {/* Search */}
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${segments.length} segments...`}
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {/* Segment list */}
              <div className="max-h-44 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                {filteredSegments.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-[var(--text-3)]">No matching segments</div>
                ) : (
                  filteredSegments.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => loadMembers(s.id, s.name)}
                      className={`flex items-center justify-between w-full px-3 py-2 text-left text-sm transition-colors border-b border-[var(--border)] last:border-b-0 ${
                        selectedSegmentId === s.id
                          ? "bg-blue-500/10 text-blue-400"
                          : "text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
                      }`}
                    >
                      <span className="truncate">{s.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ml-2 ${
                        s.type === "dynamic"
                          ? "bg-indigo-500/10 text-indigo-400"
                          : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
                      }`}>{s.type}</span>
                    </button>
                  ))
                )}
              </div>

              {/* Members loading */}
              {membersLoading && (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-[var(--text-3)]">
                  <Loader2 size={14} className="animate-spin" />
                  Loading people...
                </div>
              )}

              {/* Members error */}
              {membersError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
                  {membersError}
                </div>
              )}

              {/* Members preview */}
              {members && !membersLoading && (
                <>
                  {members.length === 0 ? (
                    <p className="text-sm text-[var(--text-3)] text-center py-2">No people in this segment.</p>
                  ) : (
                    <>
                      {/* Summary bar */}
                      <div className="flex items-center justify-between bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                        <div>
                          <p className="text-sm text-[var(--text-1)] font-medium">{selectedSegmentName}</p>
                          <p className="text-xs text-[var(--text-3)] mt-0.5">
                            <span className="text-[var(--text-2)] font-semibold">{membersWithPhone.length}</span> of {members.length} contacts have phone numbers
                          </p>
                        </div>
                        {membersWithPhone.length > 0 && (
                          <button
                            type="button"
                            onClick={handleImport}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors shadow-md shadow-blue-600/20"
                          >
                            <Download size={13} />
                            Import {membersWithPhone.length}
                          </button>
                        )}
                      </div>

                      {/* Compact member list */}
                      <div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-[var(--bg-card)] border-b border-[var(--border)]">
                            <tr>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Name</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Phone</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Email</th>
                            </tr>
                          </thead>
                          <tbody>
                            {members.map((m) => (
                              <tr key={m.id} className="border-t border-[var(--border)]">
                                <td className="px-3 py-1.5 text-[var(--text-2)]">{m.name ?? "—"}</td>
                                <td className={`px-3 py-1.5 font-mono ${m.phone ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}`}>
                                  {m.phone ?? "—"}
                                </td>
                                <td className="px-3 py-1.5 text-[var(--text-3)]">{m.email ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
