import { supabase } from "./supabase";

export interface DncEntry {
  id: number;
  phoneNumber: string;
  addedAt: string;
  archived: boolean;
}

const LS_KEY = "dnc_entries_v3";

// ── localStorage helpers ──────────────────────────────────────────────────────
function lsLoad(): DncEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return raw.map((e: any) => ({ ...e, archived: e.archived ?? false }));
  } catch {
    return [];
  }
}

function lsSave(entries: DncEntry[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_KEY, JSON.stringify(entries));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): DncEntry {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    addedAt: new Date(row.added_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    archived: row.archived ?? false,
  };
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchDncEntries(): Promise<DncEntry[]> {
  try {
    const { data, error } = await supabase
      .from("do_not_call")
      .select("*")
      .order("added_at", { ascending: false });

    if (!error && data) {
      const entries = data.map(rowToEntry);
      lsSave(entries);
      return entries;
    }
  } catch {
    // fall through to local
  }
  return lsLoad();
}

export async function insertDncEntries(phoneNumbers: string[]): Promise<DncEntry[]> {
  const trimmed = phoneNumbers.map((n) => n.trim()).filter(Boolean);

  try {
    const rows = trimmed.map((n) => ({ phone_number: n, archived: false }));
    const { data, error } = await supabase
      .from("do_not_call")
      .upsert(rows, { onConflict: "phone_number", ignoreDuplicates: true })
      .select();

    if (!error && data) {
      const inserted = data.map(rowToEntry);
      const cached = lsLoad();
      const existingNums = new Set(cached.map((e) => e.phoneNumber));
      const fresh = inserted.filter((e) => !existingNums.has(e.phoneNumber));
      lsSave([...fresh, ...cached]);
      return inserted;
    }
  } catch {
    // fall through to local
  }

  // Local fallback
  const existing = lsLoad();
  const existingNums = new Set(existing.map((e) => e.phoneNumber));
  const now = formatDate();
  const fresh: DncEntry[] = trimmed
    .filter((n) => !existingNums.has(n))
    .map((n, i) => ({ id: Date.now() + i, phoneNumber: n, addedAt: now, archived: false }));
  lsSave([...fresh, ...existing]);
  return fresh;
}

export async function archiveDncEntry(id: number): Promise<void> {
  try {
    await supabase.from("do_not_call").update({ archived: true }).eq("id", id);
  } catch {
    // ignore — update locally regardless
  }
  lsSave(lsLoad().map((e) => (e.id === id ? { ...e, archived: true } : e)));
}

export async function restoreDncEntry(id: number): Promise<void> {
  try {
    await supabase.from("do_not_call").update({ archived: false }).eq("id", id);
  } catch {
    // ignore
  }
  lsSave(lsLoad().map((e) => (e.id === id ? { ...e, archived: false } : e)));
}

export async function deleteDncEntry(id: number): Promise<void> {
  try {
    await supabase.from("do_not_call").delete().eq("id", id);
  } catch {
    // ignore
  }
  lsSave(lsLoad().filter((e) => e.id !== id));
}

export async function fetchArchivedDncEntries(): Promise<DncEntry[]> {
  const { data, error } = await supabase
    .from("do_not_call")
    .select("*")
    .eq("archived", true)
    .order("added_at", { ascending: false });
  if (error) return [];
  return (data ?? []).map(rowToEntry);
}
