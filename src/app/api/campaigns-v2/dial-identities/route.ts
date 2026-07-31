/**
 * GET /api/campaigns-v2/dial-identities
 *
 * The wizard's identity preview source: which SMS originator each brand sends
 * under, and which caller ID each country presents. Resolved by the SAME
 * functions the dialer/sender use (resolveSmsSenderId, buildCallerIdMap), so
 * the wizard display can never disagree with what actually goes out.
 *
 * Values are non-secret (shown to customers). Behind the dashboard Basic Auth
 * middleware like every /api/campaigns-v2/* route. A null sender means that
 * brand has no configured Mobivate originator — the wizard surfaces it as a
 * warning instead of silently implying it will send.
 */

import { NextResponse } from "next/server";
import { listConfiguredWorkspaces } from "@/lib/customerio";
import { resolveSmsSenderId } from "@/lib/mobivate";
import { buildCallerIdMap } from "@/lib/freeswitch/callerId";

export async function GET() {
  const senders: Record<string, string | null> = {};
  for (const ws of listConfiguredWorkspaces()) {
    senders[ws] = resolveSmsSenderId(ws).senderId;
  }
  return NextResponse.json({ senders, callers: buildCallerIdMap() });
}
