// Pure derivation of a campaign's live dialing-flow state from its campaign_numbers_v2 rows,
// for the read-only RunFlowStrip on the detail page. Mirrors the dialer's findNextNumber
// selection (src/lib/dialer.ts) EXACTLY: dial order = next_attempt_at (NULLS FIRST, so a fresh
// `pending` dials before due retries) → created_at → id. "Up next" = the first such number that's
// `pending`, or a `pending_retry` whose window has arrived, under max_attempts — i.e. the number
// findNextNumber would actually return next. NO I/O — `nowMs` is injected so the module stays
// pure + testable.
//
// NOTE: this DISPLAYS state the dialer already owns; it never selects or fires anything. The
// final dial pick also re-checks the do-not-call lists at dial time (rare), so "Up next" is
// "next in line", not a guarantee.

export interface RunFlowNumber {
  phone_e164?: string | null;
  outcome?: string | null;
  next_attempt_at?: string | null;
  attempt_count?: number | null;
  created_at?: string | null;
  id?: string | null;
}

export interface RunFlowTarget {
  phone: string;
}

export interface RunFlow {
  total: number;
  done: number; // resolved to a terminal disposition (no more work)
  pending: number;
  awaitingRetry: number;
  dueNow: number; // subset of awaitingRetry whose window has already passed (eligible to dial now)
  inProgress: number;
  nowDialing: RunFlowTarget | null;
  upNext: RunFlowTarget | null;
  nextRetryAt: string | null; // earliest FUTURE retry window (ISO), or null
}

function ts(v: string | null | undefined): number {
  if (!v) return Number.POSITIVE_INFINITY;
  const t = Date.parse(v);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

// Stable id tiebreak (uuid PK) — mirrors findNextNumber's `.order("id")`. Lexicographic string
// compare matches Postgres's canonical-uuid ordering, so the preview and the dialer agree on ties.
function cmpId(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? "", y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

// next_attempt_at as a sort key with NULLS FIRST: a null window (fresh `pending`) sorts ahead of
// any timestamped retry, matching findNextNumber's `.order("next_attempt_at",{nullsFirst:true})`.
function naKey(v: string | null | undefined): number {
  if (v == null) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(v);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

// Full dial order, identical to findNextNumber: next_attempt_at (nulls first) → created_at → id.
// Comparison-based (not subtraction) to avoid NaN when keys are ±Infinity.
function cmpDial(a: RunFlowNumber, b: RunFlowNumber): number {
  const na = naKey(a.next_attempt_at), nb = naKey(b.next_attempt_at);
  if (na !== nb) return na < nb ? -1 : 1;
  const ca = ts(a.created_at), cb = ts(b.created_at);
  if (ca !== cb) return ca < cb ? -1 : 1;
  return cmpId(a.id, b.id);
}

export function deriveRunFlow(
  numbers: RunFlowNumber[],
  opts: { maxAttempts: number; nowMs: number },
): RunFlow {
  const { maxAttempts, nowMs } = opts;
  // Dial order mirrors findNextNumber EXACTLY: next_attempt_at (nulls first) → created_at → id.
  // Fresh `pending` (null window) dials before due retries; batch-identical created_at is broken
  // by the uuid id. Keeps "Up next" == the number the dialer actually fires next.
  const ordered = [...numbers].sort(cmpDial);

  let pending = 0;
  let awaitingRetry = 0;
  let dueNow = 0;
  let inProgress = 0;
  let nowDialing: RunFlowTarget | null = null;
  let upNext: RunFlowTarget | null = null;
  let nextRetryAt: string | null = null;
  let nextRetryMs = Number.POSITIVE_INFINITY;

  for (const n of ordered) {
    const outcome = n.outcome ?? "pending";
    const phone = n.phone_e164 ?? "";
    const attempts = n.attempt_count ?? 0;
    const retryDue =
      outcome === "pending_retry" && n.next_attempt_at != null && ts(n.next_attempt_at) <= nowMs;

    if (outcome === "pending") pending++;
    else if (outcome === "pending_retry") {
      awaitingRetry++;
      if (retryDue) dueNow++;
    } else if (outcome === "in_progress") inProgress++;

    if (outcome === "in_progress" && nowDialing === null) {
      nowDialing = { phone };
    }

    // Up next mirrors findNextNumber: a fresh `pending`, or a `pending_retry` whose window has
    // arrived; under max_attempts; first in dial order (already next_attempt_at-first above).
    if (upNext === null && attempts < maxAttempts && (outcome === "pending" || retryDue)) {
      upNext = { phone };
    }

    // Earliest FUTURE retry window — when the next queued retry becomes eligible.
    if (outcome === "pending_retry" && n.next_attempt_at != null) {
      const m = ts(n.next_attempt_at);
      if (m > nowMs && m < nextRetryMs) {
        nextRetryMs = m;
        nextRetryAt = n.next_attempt_at;
      }
    }
  }

  const total = ordered.length;
  const done = total - pending - awaitingRetry - inProgress;
  return { total, done, pending, awaitingRetry, dueNow, inProgress, nowDialing, upNext, nextRetryAt };
}
