import { parsePhoneList } from "../campaignV2Shared";

// Parses a manual GhostPortal upload (CSV / JSON / paste) into normalized,
// deduped E.164 targets. Reuses parsePhoneList() — the SAME normalizer the
// production wizard uses — so ghost numbers are shaped identically. Invalid
// rows are surfaced in `rejected` (loud, never silently dropped).

export type GhostUploadFormat = "paste" | "csv" | "json";
export interface GhostTarget {
  phone: string;
  meta?: Record<string, unknown>;
}
export interface GhostUploadResult {
  targets: GhostTarget[];
  rejected: string[];
}

function normOne(raw: string): string | null {
  const [only] = parsePhoneList(raw);
  return only ?? null;
}

export function parseGhostUpload(format: GhostUploadFormat, raw: string): GhostUploadResult {
  const targets: GhostTarget[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  const push = (phone: string | null, src: string, meta?: Record<string, unknown>) => {
    if (!phone) {
      rejected.push(src);
      return;
    }
    if (seen.has(phone)) return;
    seen.add(phone);
    targets.push(meta ? { phone, meta } : { phone });
  };

  if (format === "json") {
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      return { targets: [], rejected: [raw.slice(0, 80)] };
    }
    if (!Array.isArray(arr)) return { targets: [], rejected: ["(not a JSON array)"] };
    for (const row of arr) {
      if (row && typeof row === "object" && "phone" in row) {
        const { phone, ...meta } = row as Record<string, unknown>;
        push(
          normOne(String(phone)),
          JSON.stringify(row).slice(0, 80),
          Object.keys(meta).length ? meta : undefined,
        );
      } else {
        rejected.push(JSON.stringify(row).slice(0, 80));
      }
    }
    return { targets, rejected };
  }

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (format === "csv") {
    const header = lines.shift()?.split(",").map((h) => h.trim().toLowerCase()) ?? [];
    const phoneIdx = header.indexOf("phone");
    if (phoneIdx === -1) return { targets: [], rejected: ["(no 'phone' column in header)"] };
    for (const line of lines) {
      const cols = line.split(",");
      const meta: Record<string, unknown> = {};
      header.forEach((h, i) => {
        if (i !== phoneIdx && cols[i] !== undefined) meta[h] = cols[i].trim();
      });
      push(
        normOne(cols[phoneIdx] ?? ""),
        line.slice(0, 80),
        Object.keys(meta).length ? meta : undefined,
      );
    }
    return { targets, rejected };
  }

  // paste
  for (const token of raw.split(/[\n,]+/g).map((t) => t.trim()).filter(Boolean)) {
    push(normOne(token), token);
  }
  return { targets, rejected };
}
