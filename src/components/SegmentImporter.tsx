"use client";

/**
 * SegmentImporter — Customer.io segment browser for the Campaign V2 create page.
 *
 * Collapsed by default. When expanded, lets the operator search segments,
 * pick one, preview its members (name + phone), and append valid phone
 * numbers to the parent form's number list.
 *
 * Less-is-more design:
 *   - No external state library — local useState only
 *   - No custom autocomplete library — native filter on the segments list
 *   - Members with no phone appear in preview (with "—") but aren't imported
 *   - Single callback to parent: onImport(phones[])
 *
 * Spec: .agent/tasks/2026-04-16_TASK_SMS_Mobivate_CustomerIO.md (Segment Import)
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Search, Users } from "lucide-react";

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
  /** Called when the operator clicks "Add N numbers to list". Receives valid phone numbers. */
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

  // Fetch segments once when the section is expanded
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

  // Filter segments by search term (case-insensitive). Cap displayed matches.
  const filteredSegments = useMemo(() => {
    if (!segments) return [];
    const term = search.trim().toLowerCase();
    const list = term
      ? segments.filter((s) => s.name.toLowerCase().includes(term))
      : segments;
    return list.slice(0, 50); // cap the dropdown list
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
    // Collapse after successful import — signals "done" visually
    setExpanded(false);
    setSelectedSegmentId(null);
    setSelectedSegmentName(null);
    setMembers(null);
    setSearch("");
  }

  const membersWithPhone = members?.filter((m) => m.phone) ?? [];

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-[var(--text-2)] hover:text-[var(--text-1)]"
      >
        <span className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <Users className="h-4 w-4" />
          Import from Customer.io segment
        </span>
        {selectedSegmentName && !expanded && (
          <span className="text-xs text-[var(--text-3)]">({selectedSegmentName})</span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-3 py-3">
          {/* Segments: loading / error / list */}
          {segments === null && !segmentsError && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-3)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading segments…
            </div>
          )}
          {segmentsError && (
            <div className="rounded bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {segmentsError}
            </div>
          )}
          {segments && (
            <>
              {/* Search box */}
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-3)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${segments.length} segments…`}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] py-1.5 pl-8 pr-3 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              {/* Segment list */}
              <div className="mb-3 max-h-48 overflow-y-auto rounded-md border border-[var(--border)]">
                {filteredSegments.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[var(--text-3)]">No matches.</div>
                ) : (
                  filteredSegments.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => loadMembers(s.id, s.name)}
                      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)] ${
                        selectedSegmentId === s.id
                          ? "bg-[var(--surface-2)] text-[var(--accent)]"
                          : "text-[var(--text-2)]"
                      }`}
                    >
                      {s.name}
                      <span className="ml-2 text-xs text-[var(--text-3)]">{s.type}</span>
                    </button>
                  ))
                )}
              </div>

              {/* Members: loading / error / preview table */}
              {membersLoading && (
                <div className="flex items-center gap-2 text-sm text-[var(--text-3)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading people…
                </div>
              )}
              {membersError && (
                <div className="rounded bg-red-500/10 px-3 py-2 text-sm text-red-400">
                  {membersError}
                </div>
              )}
              {members && !membersLoading && (
                <div>
                  <div className="mb-2 text-xs text-[var(--text-3)]">
                    {members.length === 0
                      ? "No people in this segment."
                      : `${membersWithPhone.length} of ${members.length} have phone numbers`}
                  </div>

                  {members.length > 0 && (
                    <div className="mb-3 max-h-56 overflow-y-auto rounded-md border border-[var(--border)]">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-[var(--surface-2)] text-[var(--text-3)]">
                          <tr>
                            <th className="px-2 py-1.5 font-medium">Name</th>
                            <th className="px-2 py-1.5 font-medium">Phone</th>
                            <th className="px-2 py-1.5 font-medium">Email</th>
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m) => (
                            <tr
                              key={m.id}
                              className="border-t border-[var(--border)] text-[var(--text-2)]"
                            >
                              <td className="px-2 py-1.5">{m.name ?? "—"}</td>
                              <td className="px-2 py-1.5">{m.phone ?? "—"}</td>
                              <td className="px-2 py-1.5 text-[var(--text-3)]">{m.email ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {membersWithPhone.length > 0 && (
                    <button
                      type="button"
                      onClick={handleImport}
                      className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                    >
                      Add {membersWithPhone.length} number{membersWithPhone.length === 1 ? "" : "s"} to list
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
