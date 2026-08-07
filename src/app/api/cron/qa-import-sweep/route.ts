import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { importCompletedBatches } from "@/lib/qaBatchSubmit";

/**
 * GET /api/cron/qa-import-sweep — Vercel Cron (see vercel.json), every few hours.
 *
 * Standalone import sweep so manual all-campaigns / per-campaign batches get imported
 * automatically without anyone clicking. Idempotent + resume-safe. No submits here — a
 * pure poll + import, so it's safe to run regardless of the daily schedule's on/off state.
 */
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const expected = `Bearer ${cronSecret}`;
  const received = request.headers.get("authorization") || "";
  return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "Not configured" }, { status: 500 });
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
  try {
    const result = await importCompletedBatches(apiKey);
    console.log(`[qa-import-sweep] imported=${result.imported} completed=${result.completed} active=${result.active}`);
    return NextResponse.json(result);
  } catch (e) {
    console.error("[qa-import-sweep] failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Import sweep failed" }, { status: 500 });
  }
}
