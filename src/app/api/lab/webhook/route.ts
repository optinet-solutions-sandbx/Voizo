// VAPI server webhook for the Script Engine test rig (attended builder runs).
// Thin route: parse + unwrap the VAPI envelope, delegate to the engine core.
// The engine logic lives in src/lib/scriptEngine/handleWebhook.ts so the
// Phase-2 campaign script-call route can reuse it after its own auth + call
// resolution.
import { NextResponse } from "next/server";
import crypto from "crypto";
// Relative import — vitest does not resolve "@/" (same testable-route
// convention as the ghost + customerio routes).
import { handleWebhook, type VapiMessage } from "../../../../lib/scriptEngine/handleWebhook";

export const dynamic = "force-dynamic";
// A turn can legitimately hold the line for a while (speaking lock up to 6s +
// classification + injection) — don't let the platform kill it mid-injection.
export const maxDuration = 60;

export async function POST(req: Request) {
  // ── Vapi webhook authentication (VOZ-186; same block as end-of-call) ──
  // configure-assistant sets server.secret on the lab assistant, so Vapi sends
  // the raw token as x-vapi-secret. This route is exempted from Basic Auth in
  // middleware — this check IS its auth. Constant-time comparison.
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET || process.env.VAPI_PRIVATE_KEY;
  const vapiSecretHeader = req.headers.get("x-vapi-secret");
  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error("FATAL: VAPI_WEBHOOK_SECRET not set — rejecting lab webhook");
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }
    console.warn("Lab webhook: no webhook secret configured (accepting in dev only)");
  } else if (!vapiSecretHeader) {
    console.warn("Lab webhook: missing x-vapi-secret header — rejecting");
    return NextResponse.json({ error: "Missing signature" }, { status: 403 });
  } else {
    const received = Buffer.from(vapiSecretHeader, "utf-8");
    const expected = Buffer.from(webhookSecret, "utf-8");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      console.warn("Lab webhook: invalid x-vapi-secret — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }
  }

  let message: VapiMessage;
  try {
    const body = await req.json();
    message = body?.message ?? {};
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  return handleWebhook(message);
}
