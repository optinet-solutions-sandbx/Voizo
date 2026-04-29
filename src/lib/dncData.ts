export interface DncEntry {
  id: string;
  phoneNumber: string;
  reason: string;
  addedBy: string;
  addedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): DncEntry {
  return {
    id: row.id,
    phoneNumber: row.phone_e164,
    reason: row.reason || "manual",
    addedBy: row.added_by || "operator",
    addedAt: new Date(row.added_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
  };
}

export async function fetchDncEntries(): Promise<DncEntry[]> {
  const res = await fetch("/api/dnc");
  if (!res.ok) {
    console.error("Failed to fetch suppression list:", res.status);
    return [];
  }
  const body = await res.json();
  return (body.entries ?? []).map(rowToEntry);
}

export async function insertDncEntries(phoneNumbers: string[]): Promise<DncEntry[]> {
  const trimmed = phoneNumbers.map((n) => n.trim()).filter(Boolean);
  const res = await fetch("/api/dnc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phoneNumbers: trimmed }),
  });
  if (!res.ok) {
    console.error("Failed to insert suppression entries:", res.status);
    return [];
  }
  const body = await res.json();
  return (body.entries ?? []).map(rowToEntry);
}

export async function deleteDncEntry(id: string): Promise<void> {
  const res = await fetch(`/api/dnc?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    console.error("Failed to delete suppression entry:", res.status);
  }
}
