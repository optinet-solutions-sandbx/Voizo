/**
 * GET /api/vapi-assistants — the Script Builder lab's assistant list (VOZ-186).
 *
 * DELIBERATELY returns exactly ONE assistant: the designated script base
 * (VAPI_SCRIPT_BASE_ASSISTANT_ID). Team decision 2026-07-22: the lab tests the
 * SAME assistant real script campaigns clone from, so what Val hears in a test
 * call is what campaigns get. Listing the whole account here (the source app's
 * behavior) invited testing against — and overwriting — the wrong agent.
 *
 * Response is a BARE array [{id, name}] — the shape the ported LabConfigForm
 * expects (unlike /api/vapi/assistants, which boxes it as {assistants} for the
 * campaign wizard). Keeping the contract lets the lab panel stay drop-in
 * compatible with the source app.
 *
 * Server-side only — the Vapi private key never leaves this handler.
 */

import { NextResponse } from "next/server";

export async function GET() {
  const id = process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!id || !key) {
    console.error(
      "[vapi-assistants] VAPI_SCRIPT_BASE_ASSISTANT_ID / VAPI_PRIVATE_KEY not set — the lab has no test agent",
    );
    return NextResponse.json(
      { error: "VAPI_SCRIPT_BASE_ASSISTANT_ID is not configured" },
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
