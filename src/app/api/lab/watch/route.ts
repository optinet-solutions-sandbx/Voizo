// Delivery-watchdog tick, driven by the Script Builder's 1.2s run poll.
// Serverless freezes background timers and the VAPI webhook goes silent
// exactly when the agent swallows a briefing (nobody is speaking → no
// events), so the browser poll is the only reliable clock in production.
// The check is cheap (one query when nothing is pending) and idempotent
// across concurrent invocations via persisted marker events.
import { NextResponse } from "next/server";
import { checkDelivery, checkWaitTimeout } from "@/lib/scriptEngine/lab-watchdog";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  let callId: unknown;
  try {
    callId = (await req.json())?.callId;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof callId !== "string" || !callId) {
    return NextResponse.json({ error: "callId required" }, { status: 400 });
  }
  await checkDelivery(callId, null);
  await checkWaitTimeout(callId, null);
  return NextResponse.json({});
}
