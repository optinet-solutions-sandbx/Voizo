import { NextRequest, NextResponse } from "next/server";
import { upsertLabel, VERDICTS, type Verdict } from "@/lib/labelData";
import { rejectIfCrossOriginStrict } from "@/lib/csrf";

/**
 * POST /api/reviews/label
 *
 * Upserts this reviewer's good/bad/unsure verdict (+ optional reason) for a call.
 * Body: { callId: uuid, verdict: "good"|"bad"|"unsure", reason?: string }.
 *
 * Mutating → strict CSRF (matches /api/campaigns-v2/[id]/is-test).
 * Writes via service role; call_labels is default-deny to the anon key.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

function reviewerFrom(): string {
  return process.env.DASHBOARD_USERNAME || "operator";
}

export async function POST(request: NextRequest) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  let body: { callId?: unknown; verdict?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const callId = typeof body.callId === "string" ? body.callId : "";
  if (!UUID_RE.test(callId)) {
    return NextResponse.json({ error: "callId (uuid) is required" }, { status: 400 });
  }
  if (typeof body.verdict !== "string" || !VERDICTS.includes(body.verdict as Verdict)) {
    return NextResponse.json(
      { error: `verdict must be one of: ${VERDICTS.join(", ")}` },
      { status: 400 },
    );
  }
  let reason: string | null = null;
  if (body.reason != null) {
    if (typeof body.reason !== "string") {
      return NextResponse.json({ error: "reason must be a string" }, { status: 400 });
    }
    reason = body.reason.trim().slice(0, REASON_MAX) || null;
  }

  try {
    const label = await upsertLabel({
      callId,
      verdict: body.verdict as Verdict,
      reason,
      labeledBy: reviewerFrom(),
    });
    console.log(`[reviews/label] call=${callId} verdict=${label.verdict} by=${label.labeledBy}`);
    return NextResponse.json({ ok: true, label });
  } catch (err) {
    console.error("[reviews/label] failed:", err);
    return NextResponse.json({ error: "Failed to save label" }, { status: 500 });
  }
}
