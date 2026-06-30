"use client";

// Source-agnostic export engine (Slice B2). The CSV / transcript-zip / audio-zip-via-proxy logic,
// extracted VERBATIM from useCampaignExport so both the per-campaign page and the cross-campaign Global
// drawer drive ONE copy. It operates purely on ExportLead[] (from exportLeads.ts) + a filename resolver
// + a progress setter + an AbortSignal — no knowledge of where the leads came from. Callers own the
// fetch + try/catch/finally; runExport throws on empty/over-cap so the caller surfaces it.
//
//   csv         → single .csv (metadata + transcripts column), UTF-8 BOM, formula-escaped.
//   transcripts → .zip of transcripts/<phone>/attempt_<N>.txt (no network — text is in the leads).
//   audio       → .zip with summary.csv + recordings/<phone>/attempt_<N>_<dur>s.<ext>, streamed via
//                 /api/recordings/proxy (CORS), concurrency 5, hard-capped at 500 (browser-memory OOM).

import type { Dispatch, SetStateAction } from "react";
import JSZip from "jszip";
import { triggerDownload, csvCell, CSV_BOM } from "./download";
import type { ExportAttempt, ExportLead } from "./exportLeads";

export type ExportMode = "csv" | "audio" | "transcripts";
export interface ExportProgress {
  current: number;
  total: number;
  stage: string;
}

const AUDIO_CONCURRENCY = 5;
const AUDIO_BUNDLE_MAX = 500;

// Excel formula-escape trick: ="+44..." preserves the leading + that Excel would otherwise strip.
function csvPhoneCell(phone: string): string {
  return `"=""${phone.replace(/"/g, '""')}"""`;
}

function buildCsv(leads: ExportLead[], includeSmsCols: boolean): string {
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
    // Most recent SMS by createdAt — the offer SMS that actually went out post-goal-reached.
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
        cells.push(csvCell(sms?.body), csvCell(sms?.status), csvCell(sms?.providerMessageId), csvCell(sms?.createdAt));
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
        csvCell(att.goalReached === null ? "" : att.goalReached ? "Yes" : "No"),
        csvCell(att.transcript),
      ];
      if (includeSmsCols) {
        cells.push(csvCell(sms?.body), csvCell(sms?.status), csvCell(sms?.providerMessageId), csvCell(sms?.createdAt));
      }
      rows.push(cells.join(","));
    }
  }

  return CSV_BOM + rows.join("\r\n") + "\r\n";
}

function sanitizePhoneForFolder(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

// File extension from Content-Type at fetch time, not the URL (Vapi serves .wav by default but the
// recordingFormat can flip to .mp3).
function extFromContentType(ct: string | null): string {
  if (!ct) return "wav";
  const lower = ct.toLowerCase();
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("wav") || lower.includes("wave")) return "wav";
  return "wav";
}

/** Compile + download the export for `leads` in `mode`. `filename(mode)` yields the download name
 *  (callers keep their own naming). Throws on no-data / over-cap / abort — caller handles. */
export async function runExport(opts: {
  leads: ExportLead[];
  mode: ExportMode;
  includeSmsCols: boolean;
  filename: (mode: ExportMode) => string;
  signal: AbortSignal;
  onProgress: Dispatch<SetStateAction<ExportProgress>>;
}): Promise<void> {
  const { leads, mode, includeSmsCols, filename, signal, onProgress } = opts;

  if (mode === "csv") {
    const csvContent = buildCsv(leads, includeSmsCols);
    onProgress({ current: 1, total: 1, stage: "Triggering download..." });
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, filename("csv"));
    return;
  }

  if (mode === "transcripts") {
    const zip = new JSZip();
    const transcriptsFolder = zip.folder("transcripts");
    const skipped: string[] = [];

    let written = 0;
    let total = 0;
    for (const lead of leads) {
      for (const att of lead.attempts) {
        total++;
        const text = att.transcript?.trim();
        if (!text) {
          skipped.push(`${lead.phone} attempt #${att.attemptNumber}: no transcript text`);
          continue;
        }
        const folder = transcriptsFolder?.folder(sanitizePhoneForFolder(lead.phone));
        folder?.file(`attempt_${att.attemptNumber}.txt`, text + "\n");
        written++;
      }
    }

    if (total === 0) throw new Error("No calls exist for this filter.");
    if (written === 0) throw new Error("No call transcripts exist for this filter.");

    if (skipped.length > 0) {
      zip.file(
        "skipped.txt",
        `The following calls had no transcript text:\n\n${skipped.join("\n")}\n\nThe rest of the bundle is unaffected.\n`,
      );
    }

    onProgress({ current: written, total: written, stage: "Compiling ZIP archive..." });
    const zipBlob = await zip.generateAsync({ type: "blob" });
    triggerDownload(zipBlob, filename("transcripts"));
    return;
  }

  // mode === "audio"
  const csvContent = buildCsv(leads, includeSmsCols);
  const zip = new JSZip();
  zip.file("summary.csv", csvContent);
  const recordingsFolder = zip.folder("recordings");
  const skipped: string[] = [];

  const queue: { phone: string; attempt: ExportAttempt }[] = [];
  for (const lead of leads) {
    for (const att of lead.attempts) {
      if (att.recordingUrl) queue.push({ phone: lead.phone, attempt: att });
    }
  }

  const total = queue.length;
  if (total === 0) throw new Error("No call recordings exist for this filter.");

  // Cap audio bundles. JSZip materializes the whole archive in browser memory; 500 × ~2 MB ≈ 1 GB
  // resident heap (OOMs Chrome ~2 GB). Refuse rather than crash; operators narrow the filter.
  if (total > AUDIO_BUNDLE_MAX) {
    throw new Error(
      `Audio bundles are limited to ${AUDIO_BUNDLE_MAX} recordings (this filter has ${total}). ` +
        `Refine the filter or split by outcome category.`,
    );
  }

  onProgress({ current: 0, total, stage: `Downloading 0 of ${total} recordings...` });

  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const myIdx = idx++;
      const { phone, attempt } = queue[myIdx];
      const proxyUrl = `/api/recordings/proxy?url=${encodeURIComponent(attempt.recordingUrl as string)}`;
      try {
        const r = await fetch(proxyUrl, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        const ext = extFromContentType(r.headers.get("content-type"));
        const folder = recordingsFolder?.folder(sanitizePhoneForFolder(phone));
        folder?.file(`attempt_${attempt.attemptNumber}_${attempt.durationSeconds ?? 0}s.${ext}`, buf);
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        skipped.push(`${phone} attempt #${attempt.attemptNumber}: ${(err as Error).message}`);
      }
      onProgress((prev) => {
        const next = prev.current + 1;
        return { current: next, total, stage: `Downloading ${next} of ${total} recordings...` };
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(AUDIO_CONCURRENCY, total) }, worker));

  if (skipped.length > 0) {
    zip.file(
      "skipped.txt",
      `The following recordings failed to download:\n\n${skipped.join("\n")}\n\nThe rest of the bundle is unaffected.\n`,
    );
  }

  onProgress({ current: total, total, stage: "Compiling ZIP archive..." });
  const zipBlob = await zip.generateAsync({ type: "blob" });
  triggerDownload(zipBlob, filename("audio"));
}
