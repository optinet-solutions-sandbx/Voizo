// Pure per-contact export-detail builder (Slice B2). Server-safe (NO "use client") so the
// cross-campaign export-metadata route can import it; the client export ENGINE (runExport, JSZip)
// lives separately in recordsExportEngine.ts. Produces the ExportLead shape the engine consumes,
// from a window's calls + numbers + sms. Filtering by the clicked slice happens upstream (via
// computeCallRecords + filterRecordsBySlice); this builder just maps detail for the matching contacts.

export interface ExportAttempt {
  attemptNumber: number; // 1-based, created_at asc
  status: string;
  durationSeconds: number | null;
  goalReached: boolean | null;
  transcript: string | null; // unwrapped from the calls_v2.transcript jsonb {text} (or plain string)
  recordingUrl: string | null;
  createdAt: string;
}

export interface ExportSms {
  body: string;
  status: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExportLead {
  phone: string;
  outcome: string;
  attemptCount: number;
  lastAttemptedAt: string | null;
  attempts: ExportAttempt[];
  smsMessages: ExportSms[];
}

// Input row shapes (subset of the DB columns the export needs).
export interface ExportNumberRow {
  id: string;
  phone_e164?: string | null;
  outcome?: string | null;
}
export interface ExportCallRow {
  campaign_number_id?: string | null;
  status: string;
  goal_reached: boolean | null;
  duration_seconds?: number | null;
  transcript?: string | { text?: string } | null;
  recording_url?: string | null;
  created_at: string;
}
export interface ExportSmsRow {
  campaign_number_id?: string | null;
  body: string;
  status: string;
  provider_message_id?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/** calls_v2.transcript is jsonb `{ text }` from the DB, but a plain string in tests. */
function transcriptText(t: ExportCallRow["transcript"]): string | null {
  if (!t) return null;
  if (typeof t === "string") return t;
  return t.text ?? null;
}

/** One ExportLead per number (keyed by campaign_number_id). Calls/sms are grouped by
 *  campaign_number_id; attempts are ordered by created_at asc. Numbers with no calls still
 *  produce a lead (empty attempts) — matches the per-campaign export-metadata behaviour. */
export function buildExportLeads(
  numbers: ExportNumberRow[],
  calls: ExportCallRow[],
  sms: ExportSmsRow[],
): Map<string, ExportLead> {
  const callsByNumber = new Map<string, ExportCallRow[]>();
  for (const c of calls) {
    const id = c.campaign_number_id ?? "";
    if (!id) continue;
    const group = callsByNumber.get(id);
    if (group) group.push(c);
    else callsByNumber.set(id, [c]);
  }

  const smsByNumber = new Map<string, ExportSmsRow[]>();
  for (const m of sms) {
    const id = m.campaign_number_id ?? "";
    if (!id) continue;
    const group = smsByNumber.get(id);
    if (group) group.push(m);
    else smsByNumber.set(id, [m]);
  }

  const byId = new Map<string, ExportLead>();
  for (const n of numbers) {
    const group = [...(callsByNumber.get(n.id) ?? [])].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const attempts: ExportAttempt[] = group.map((c, i) => ({
      attemptNumber: i + 1,
      status: c.status,
      durationSeconds: c.duration_seconds ?? null,
      goalReached: c.goal_reached,
      transcript: transcriptText(c.transcript),
      recordingUrl: c.recording_url ?? null,
      createdAt: c.created_at,
    }));
    const lastAttemptedAt = attempts.length ? attempts[attempts.length - 1].createdAt : null;
    const smsMessages: ExportSms[] = (smsByNumber.get(n.id) ?? []).map((m) => ({
      body: m.body,
      status: m.status,
      providerMessageId: m.provider_message_id ?? null,
      errorMessage: m.error_message ?? null,
      createdAt: m.created_at,
      updatedAt: m.updated_at ?? m.created_at,
    }));
    byId.set(n.id, {
      phone: n.phone_e164 ?? "",
      outcome: n.outcome ?? "",
      attemptCount: attempts.length,
      lastAttemptedAt,
      attempts,
      smsMessages,
    });
  }
  return byId;
}
