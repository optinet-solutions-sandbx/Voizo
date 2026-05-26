"use client";

import { useCallback, useRef, useState } from "react";
import JSZip from "jszip";

/**
 * useCampaignExport
 *
 * Client-side export engine for campaign V2 reporting. Drives the Export
 * dropdown on the campaign detail page. Two output shapes:
 *
 *   CSV-only       → single .csv with metadata + transcripts
 *   CSV + Audio    → .zip with summary.csv at root and recordings/<phone>/
 *                    attempt_<N>_<duration>s.<ext> for every call that has a
 *                    recording. Audio is streamed through /api/recordings/proxy
 *                    to bypass the storage.vapi.ai CORS gap.
 *
 * Reasoning behind specific quirks:
 *   - UTF-8 BOM at the head of the CSV so Excel decodes Greek/Spanish/German
 *     transcripts correctly. Without it Excel falls back to Windows-1252 and
 *     mangles every non-ASCII character.
 *   - Phone numbers wrapped as ="+44..." (RFC 4180 quoted + Excel formula
 *     escape) so Excel preserves the leading + instead of dropping it.
 *   - File extension derived from Content-Type at fetch time, not assumed
 *     from the URL. Vapi serves .wav by default but the recordingFormat can
 *     be flipped to .mp3 at any time.
 *   - Concurrency capped at 5 to stay friendly to Vapi's CDN and the Vercel
 *     proxy. AbortController lets the operator cancel mid-flight.
 *   - Failed downloads write to skipped.txt inside the zip rather than
 *     silently disappearing — operator sees which calls didn't bundle.
 */

export type ExportType =
  | "all"
  | "sms_sent"
  | "not_interested_or_declined"
  | "voicemail"
  | "unreached_or_retry"
  | "wrong_number";

export interface ExportAttempt {
  attemptNumber: number;
  status: string;
  durationSeconds: number | null;
  goalReached: boolean | null;
  transcript: string | null;
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

export interface ExportProgress {
  current: number;
  total: number;
  stage: string;
}

const AUDIO_CONCURRENCY = 5;
const AUDIO_BUNDLE_MAX = 500;

// Prevent CSV formula injection. Cells whose first character is one of
// = + - @ \t \r are interpreted as a formula by Excel / LibreOffice / Sheets
// when the operator opens the export. Transcript text and Mobivate
// error_message values are attacker-influenced (caller speech is STT'd into
// transcript; Mobivate error strings come from the SMS provider) — both
// could legitimately start with one of those chars. Prefixing with a single
// quote disarms the formula without changing the visible value beyond the
// leading apostrophe. csvPhoneCell intentionally remains a formula and is
// exempt — it's our own controlled `="+44..."` literal.
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// Excel formula-escape trick: ="+44..." preserves the leading + that Excel
// would otherwise strip when auto-detecting "looks like a number".
function csvPhoneCell(phone: string): string {
  return `"=""${phone.replace(/"/g, '""')}"""`;
}

function buildCsv(leads: ExportLead[], includeSmsCols: boolean): string {
  // UTF-8 BOM (U+FEFF). Written as the explicit escape — a literal U+FEFF
  // is invisible in source, and a formatter or invisible-Unicode lint rule
  // could silently strip it, breaking Excel's encoding detection.
  const BOM = "\uFEFF";
  const headers = [
    "Phone",
    "Outcome",
    "Total Attempts",
    "Last Attempted At",
    "Attempt #",
    "Call Status",
    "Duration (s)",
    "Goal Reached",
    "Transcript",
  ];
  if (includeSmsCols) {
    headers.push("SMS Body", "SMS Status", "SMS Provider ID", "SMS Created At");
  }

  const rows: string[] = [headers.map(csvCell).join(",")];

  for (const lead of leads) {
    // SMS pick: most recent by createdAt. For the sms_sent filter this is
    // the SMS that actually went out post-goal-reached.
    const smsSorted = [...lead.smsMessages].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const sms = smsSorted[0];

    if (lead.attempts.length === 0) {
      const cells = [
        csvPhoneCell(lead.phone),
        csvCell(lead.outcome),
        csvCell(lead.attemptCount),
        csvCell(lead.lastAttemptedAt),
        "",
        "",
        "",
        "",
        "",
      ];
      if (includeSmsCols) {
        cells.push(
          csvCell(sms?.body),
          csvCell(sms?.status),
          csvCell(sms?.providerMessageId),
          csvCell(sms?.createdAt),
        );
      }
      rows.push(cells.join(","));
      continue;
    }

    for (const att of lead.attempts) {
      const cells = [
        csvPhoneCell(lead.phone),
        csvCell(lead.outcome),
        csvCell(lead.attemptCount),
        csvCell(lead.lastAttemptedAt),
        csvCell(att.attemptNumber),
        csvCell(att.status),
        csvCell(att.durationSeconds),
        csvCell(
          att.goalReached === null ? "" : att.goalReached ? "Yes" : "No",
        ),
        csvCell(att.transcript),
      ];
      if (includeSmsCols) {
        cells.push(
          csvCell(sms?.body),
          csvCell(sms?.status),
          csvCell(sms?.providerMessageId),
          csvCell(sms?.createdAt),
        );
      }
      rows.push(cells.join(","));
    }
  }

  return BOM + rows.join("\r\n") + "\r\n";
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizePhoneForFolder(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function extFromContentType(ct: string | null): string {
  if (!ct) return "wav";
  const lower = ct.toLowerCase();
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("wav") || lower.includes("wave")) return "wav";
  return "wav";
}

export function useCampaignExport(campaignId: string) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({
    current: 0,
    total: 0,
    stage: "",
  });
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startExport = useCallback(
    async (type: ExportType, includeAudio: boolean) => {
      setExporting(true);
      setError(null);
      setProgress({ current: 0, total: 0, stage: "Fetching metadata..." });

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch(
          `/api/campaigns-v2/${campaignId}/export-metadata?type=${type}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) {
          throw new Error(`Metadata fetch returned HTTP ${res.status}`);
        }
        const payload = await res.json();
        // Defensive: the endpoint could return `{error: "..."}` with HTTP 200
        // in unexpected paths; Array.isArray guards against `.length` crashing
        // on a non-array.
        const leads: ExportLead[] = Array.isArray(payload?.data)
          ? (payload.data as ExportLead[])
          : [];

        if (leads.length === 0) {
          throw new Error("No data matches this filter.");
        }

        const includeSmsCols = type === "sms_sent" || type === "all";
        const csvContent = buildCsv(leads, includeSmsCols);
        const safeType = type.replace(/_/g, "-");
        const shortId = campaignId.slice(0, 8);

        if (!includeAudio) {
          setProgress({ current: 1, total: 1, stage: "Triggering download..." });
          const blob = new Blob([csvContent], {
            type: "text/csv;charset=utf-8;",
          });
          triggerDownload(blob, `voizo_${safeType}_${shortId}.csv`);
          return;
        }

        const zip = new JSZip();
        zip.file("summary.csv", csvContent);
        const recordingsFolder = zip.folder("recordings");
        const skipped: string[] = [];

        const queue: { phone: string; attempt: ExportAttempt }[] = [];
        for (const lead of leads) {
          for (const att of lead.attempts) {
            if (att.recordingUrl) {
              queue.push({ phone: lead.phone, attempt: att });
            }
          }
        }

        const total = queue.length;
        if (total === 0) {
          throw new Error("No call recordings exist for this filter.");
        }

        // Cap audio bundles. JSZip materializes the entire archive in
        // browser memory before download; 500 recordings × ~2 MB ≈ 1 GB
        // resident heap, which OOMs Chrome around 2 GB. Refuse rather
        // than crash the tab. Operators can refine the filter or split
        // the export by outcome category.
        if (total > AUDIO_BUNDLE_MAX) {
          throw new Error(
            `Audio bundles are limited to ${AUDIO_BUNDLE_MAX} recordings ` +
              `(this filter has ${total}). Refine the filter or split by ` +
              `outcome category.`,
          );
        }

        setProgress({
          current: 0,
          total,
          stage: `Downloading 0 of ${total} recordings...`,
        });

        let idx = 0;
        const worker = async () => {
          while (idx < queue.length) {
            const myIdx = idx++;
            const { phone, attempt } = queue[myIdx];
            const proxyUrl = `/api/recordings/proxy?url=${encodeURIComponent(
              attempt.recordingUrl as string,
            )}`;
            try {
              const r = await fetch(proxyUrl, { signal: ctrl.signal });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const buf = await r.arrayBuffer();
              const ext = extFromContentType(r.headers.get("content-type"));
              const folder = recordingsFolder?.folder(
                sanitizePhoneForFolder(phone),
              );
              folder?.file(
                `attempt_${attempt.attemptNumber}_${attempt.durationSeconds ?? 0}s.${ext}`,
                buf,
              );
            } catch (err) {
              if ((err as Error).name === "AbortError") throw err;
              skipped.push(
                `${phone} attempt #${attempt.attemptNumber}: ${(err as Error).message}`,
              );
            }
            setProgress((prev) => {
              const next = prev.current + 1;
              return {
                current: next,
                total,
                stage: `Downloading ${next} of ${total} recordings...`,
              };
            });
          }
        };

        const workers = Array.from(
          { length: Math.min(AUDIO_CONCURRENCY, total) },
          worker,
        );
        await Promise.all(workers);

        if (skipped.length > 0) {
          zip.file(
            "skipped.txt",
            `The following recordings failed to download:\n\n${skipped.join("\n")}\n\nThe rest of the bundle is unaffected.\n`,
          );
        }

        setProgress({ current: total, total, stage: "Compiling ZIP archive..." });
        const zipBlob = await zip.generateAsync({ type: "blob" });
        triggerDownload(zipBlob, `voizo_${safeType}_${shortId}.zip`);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setError("Export cancelled.");
        } else {
          setError(err instanceof Error ? err.message : "Export failed.");
        }
      } finally {
        setExporting(false);
        abortRef.current = null;
      }
    },
    [campaignId],
  );

  return { startExport, cancel, exporting, progress, error };
}
