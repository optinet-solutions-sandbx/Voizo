/**
 * GET /api/customerio/workspaces (VOZ-201)
 *
 * Which Customer.io workspaces (brands) this install is configured to browse —
 * the wizard Brand picker's source. Labels only; the App API keys themselves
 * never leave src/lib/customerio.ts (§6 Secrets).
 *
 * Response: { workspaces: ["lucky7even", "fortuneplay", ...] } — default
 * workspace first. Empty array = Customer.io not configured at all (the
 * importer shows its existing config error instead of a picker).
 */

import { NextResponse } from "next/server";
import { listConfiguredWorkspaces } from "@/lib/customerio";

export async function GET() {
  return NextResponse.json({ workspaces: listConfiguredWorkspaces() });
}
