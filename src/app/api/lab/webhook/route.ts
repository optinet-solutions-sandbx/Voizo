// VAPI server webhook for the Script Engine test rig (attended builder runs).
// Thin route: parse + unwrap the VAPI envelope, delegate to the engine core.
// The engine logic lives in src/lib/scriptEngine/handleWebhook.ts so the
// Phase-2 campaign script-call route can reuse it after its own auth + call
// resolution.
import { NextResponse } from "next/server";
import { handleWebhook, type VapiMessage } from "@/lib/scriptEngine/handleWebhook";

export const dynamic = "force-dynamic";
// A turn can legitimately hold the line for a while (speaking lock up to 6s +
// classification + injection) — don't let the platform kill it mid-injection.
export const maxDuration = 60;

export async function POST(req: Request) {
  let message: VapiMessage;
  try {
    const body = await req.json();
    message = body?.message ?? {};
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  return handleWebhook(message);
}
