import { NextRequest, NextResponse } from "next/server";
import { freezeGoldenSet } from "@/lib/qa/goldenSetData";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * POST /api/qa/golden/freeze — cut a NEW frozen golden-set version from the current
 * clean, decided (good/bad) labels. Body (all optional): { note, campaignIds[], since,
 * until }. No judge call (read call_labels/calls_v2 → write golden tables), so no
 * qaJudgeReady gate; behind Basic-Auth (middleware) + origin-checked; service role.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });

  let body: { note?: unknown; campaignIds?: unknown; since?: unknown; until?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // empty / non-JSON body is fine — freeze with no filters
  }

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || undefined : undefined;

  let campaignIds: string[] | undefined;
  if (Array.isArray(body.campaignIds)) {
    const valid = body.campaignIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
    campaignIds = valid.length ? valid : undefined;
  }

  const since = typeof body.since === "string" && Number.isFinite(Date.parse(body.since)) ? body.since : undefined;
  const until = typeof body.until === "string" && Number.isFinite(Date.parse(body.until)) ? body.until : undefined;

  try {
    const result = await freezeGoldenSet({ note, campaignIds, since, until });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Log server-side; return no raw detail (mirrors the slice-2 snapshot-prompt route review fix).
    console.error(`[golden/freeze] ${err instanceof Error ? err.message : String(err)}`);
    // A concurrent freeze can clash on unique(version) (Postgres 23505) — that's retryable, not a 500.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      return NextResponse.json({ error: "A concurrent freeze created this version — retry" }, { status: 409 });
    }
    return NextResponse.json({ error: "Freeze failed" }, { status: 500 });
  }
}
