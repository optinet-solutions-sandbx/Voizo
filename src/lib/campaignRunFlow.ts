// Pure derivation of a campaign's live dialing-flow state from its campaign_numbers_v2 rows,
// for the read-only RunFlowStrip on the detail page. Mirrors the dialer's findNextNumber
// selection (src/lib/dialer.ts): dial order = created_at ascending; "next" = the first number
// that's `pending`, or a `pending_retry` whose window has arrived, under max_attempts. This
// keeps "Up next" honest. NO I/O — `nowMs` is injected so the module stays pure + testable.
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
}

export interface RunFlowTarget {
  phone: string;
  position: number; // 1-based, in dial (created_at) order
}

export interface RunFlow {
  total: number;
  done: number; // resolved to a terminal disposition (no more work)
  pending: number;
  awaitingRetry: number;
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

export function deriveRunFlow(
  numbers: RunFlowNumber[],
  opts: { maxAttempts: number; nowMs: number },
): RunFlow {
  const { maxAttempts, nowMs } = opts;
  // Dial order = created_at ascending (same as findNextNumber + the detail-page table).
  const ordered = [...numbers].sort((a, b) => ts(a.created_at) - ts(b.created_at));

  let pending = 0;
  let awaitingRetry = 0;
  let inProgress = 0;
  let nowDialing: RunFlowTarget | null = null;
  let upNext: RunFlowTarget | null = null;
  let nextRetryAt: string | null = null;
  let nextRetryMs = Number.POSITIVE_INFINITY;

  ordered.forEach((n, i) => {
    const outcome = n.outcome ?? "pending";
    const phone = n.phone_e164 ?? "";
    const attempts = n.attempt_count ?? 0;

    if (outcome === "pending") pending++;
    else if (outcome === "pending_retry") awaitingRetry++;
    else if (outcome === "in_progress") inProgress++;

    if (outcome === "in_progress" && nowDialing === null) {
      nowDialing = { phone, position: i + 1 };
    }

    // Up next mirrors findNextNumber: pending, or a pending_retry whose window has arrived;
    // under max_attempts; first in dial order.
    if (upNext === null && attempts < maxAttempts) {
      const eligible =
        outcome === "pending" ||
        (outcome === "pending_retry" && n.next_attempt_at != null && ts(n.next_attempt_at) <= nowMs);
      if (eligible) upNext = { phone, position: i + 1 };
    }

    // Earliest FUTURE retry window — when the next queued retry becomes eligible.
    if (outcome === "pending_retry" && n.next_attempt_at != null) {
      const m = ts(n.next_attempt_at);
      if (m > nowMs && m < nextRetryMs) {
        nextRetryMs = m;
        nextRetryAt = n.next_attempt_at;
      }
    }
  });

  const total = ordered.length;
  const done = total - pending - awaitingRetry - inProgress;
  return { total, done, pending, awaitingRetry, inProgress, nowDialing, upNext, nextRetryAt };
}
