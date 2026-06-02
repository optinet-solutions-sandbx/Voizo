// Shared client-side download + CSV-cell helpers. Lifted verbatim from
// useCampaignExport.ts so analytics export (and future callers) reuse one copy.
// Must run in a "use client" tree (uses document/URL).

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// RFC-4180 quoting + CSV formula-injection guard (prefixes a leading apostrophe
// when a cell would otherwise start with = + - @ tab or CR).
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// UTF-8 BOM (U+FEFF). Written as the explicit ﻿ escape (NOT a literal char)
// so a formatter or invisible-Unicode lint rule can't silently strip it and
// break Excel's encoding detection — same rationale as the original.
export const CSV_BOM = "\uFEFF";
