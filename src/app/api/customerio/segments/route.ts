/**
 * GET /api/customerio/segments
 *
 * Returns the list of all segments in the Customer.io workspace.
 * Used by the Campaign V2 create page to populate the segment dropdown.
 *
 * Server-side proxy — the browser never sees the Customer.io App API key.
 *
 * Manifesto compliance:
 * - Server-only key handling (§6 Secrets)
 * - No caching: segments can be edited in Customer.io at any time
 * - Simple error contract: { segments: [...] } on success, { error: "..." } on failure
 *
 * Spec: .agent/tasks/2026-04-16_TASK_SMS_Mobivate_CustomerIO.md (Segment Import section)
 */

import { NextResponse } from "next/server";
import { listSegments } from "@/lib/customerio";

export async function GET() {
  const result = await listSegments();

  if (!result.success) {
    // Distinguish configuration errors (500) from Customer.io API errors (502)
    const status = result.error.includes("CUSTOMERIO_APP_API_KEY") ? 500 : 502;
    return NextResponse.json({ error: result.error }, { status });
  }

  // Return only the fields the UI needs — avoid leaking internal fields
  const segments = result.data.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
  }));

  return NextResponse.json({ segments });
}
