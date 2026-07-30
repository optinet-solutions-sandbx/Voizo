/**
 * GET /api/vapi-assistants — the Script Builder lab's assistant list (VOZ-186).
 *
 * DELIBERATELY returns exactly ONE assistant: whichever one the lab is allowed
 * to touch (VAPI_LAB_ASSISTANT_ID, falling back to the clone donor). Listing the
 * whole account here (the source app's behavior) invited testing against — and
 * overwriting — the wrong agent.
 *
 * Team decision 2026-07-22 pointed this at the SAME assistant script campaigns
 * clone from, so what Val heard in a test call was what campaigns got. VOZ-253
 * separates them: that sharing meant every lab Save also rewrote production's
 * donor. This route must resolve the same id as the two write routes, or the
 * dropdown would offer an agent they refuse to write.
 *
 * Response is a BARE array [{id, name}] — the shape the ported LabConfigForm
 * expects (unlike /api/vapi/assistants, which boxes it as {assistants} for the
 * campaign wizard). Keeping the contract lets the lab panel stay drop-in
 * compatible with the source app.
 *
 * Server-side only — the Vapi private key never leaves this handler.
 */

import { NextResponse } from "next/server";
// Relative import — vitest does not resolve "@/" (testable-route convention).
import { labAssistantId, LAB_ASSISTANT_ENV_HINT } from "../../../lib/scriptEngine/lab-assistant";

export async function GET() {
  const id = labAssistantId();
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!id || !key) {
    console.error(
      `[vapi-assistants] ${LAB_ASSISTANT_ENV_HINT} / VAPI_PRIVATE_KEY not set — the lab has no test agent`,
    );
    return NextResponse.json(
      { error: `${LAB_ASSISTANT_ENV_HINT} is not configured` },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { error: `Vapi ${res.status}: ${body.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const a = (await res.json()) as { id: string; name?: string };
    return NextResponse.json([{ id: a.id, name: a.name ?? "(unnamed)" }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Network error: ${message}` }, { status: 502 });
  }
}
