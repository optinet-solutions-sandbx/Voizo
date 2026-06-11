import { NextRequest, NextResponse } from "next/server";
// Relative imports (vitest does not resolve "@/"; the ghost subsystem standardizes
// on relative paths so routes + lib stay unit-testable). Next/Turbopack resolve
// these fine too.
import { supabaseAdmin } from "../../../../lib/supabaseServer";
import { rejectIfCrossOrigin, rejectIfCrossOriginStrict } from "../../../../lib/csrf";
import { ghostPortalEnabled, ghostMaxTargets, GHOST_WARN_TARGETS } from "../../../../lib/ghost/ghostConfig";
import { parseGhostUpload, type GhostUploadFormat } from "../../../../lib/ghost/ghostUpload";
import { createGhostRun, listGhostRuns, type GhostTier } from "../../../../lib/ghost/ghostRunData";

/**
 * /api/ghost/runs  (GhostPortal — internal, Basic-Auth gated, dark-launched)
 *   POST — parse a manual upload, validate the tier/window gate + target cap,
 *          insert an audit run (status='draft'), and echo the parsed targets back
 *          to the client. ghost_runs stores AUDIT only — the phone list lives
 *          client-side across create→scrub→launch; every compliance gate (DNC,
 *          window) is RE-ENFORCED server-side at scrub + launch.
 *   GET  — list runs for the operator control room.
 *
 * The whole portal 404s (looks absent) when GHOST_PORTAL_ENABLED !== 'true'.
 */

const FORMATS = new Set<GhostUploadFormat>(["paste", "csv", "json"]);

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

interface CreateBody {
  name?: unknown;
  tier?: unknown;
  base_assistant_id?: unknown;
  format?: unknown;
  raw?: unknown;
  callWindows?: unknown;
}

export async function POST(request: NextRequest) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;
  if (!ghostPortalEnabled()) return notFound();

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const tier = body.tier === "test" || body.tier === "live" ? (body.tier as GhostTier) : null;
  const baseAssistantId = typeof body.base_assistant_id === "string" ? body.base_assistant_id.trim() : "";
  const format = FORMATS.has(body.format as GhostUploadFormat) ? (body.format as GhostUploadFormat) : null;
  const raw = typeof body.raw === "string" ? body.raw : null;

  if (!name || !tier || !baseAssistantId || !format || raw === null) {
    return NextResponse.json(
      { error: "name, tier ('test'|'live'), base_assistant_id, format ('paste'|'csv'|'json') and raw are required" },
      { status: 400 },
    );
  }

  // Live tier MUST have a call window — non-negotiable (test relaxes only this).
  const callWindows = Array.isArray(body.callWindows) ? body.callWindows : [];
  if (tier === "live" && callWindows.length === 0) {
    return NextResponse.json(
      { error: "A live run requires at least one call window. Add a window or use the test tier." },
      { status: 400 },
    );
  }

  const { targets, rejected } = parseGhostUpload(format, raw);
  if (targets.length === 0) {
    return NextResponse.json(
      { error: "No valid phone numbers parsed from the upload.", rejected },
      { status: 400 },
    );
  }
  const cap = ghostMaxTargets();
  if (targets.length > cap) {
    return NextResponse.json(
      { error: `Upload has ${targets.length} targets; the per-run cap is ${cap}. Split into smaller runs.` },
      { status: 413 },
    );
  }

  const operator = process.env.DASHBOARD_USERNAME ?? "operator";
  const run = await createGhostRun(supabaseAdmin, {
    name,
    operator,
    tier,
    baseAssistantId,
    uploadedCount: targets.length,
  });

  const warning =
    targets.length > GHOST_WARN_TARGETS
      ? `Large run: ${targets.length} targets (soft warn above ${GHOST_WARN_TARGETS}). This will place real calls.`
      : undefined;

  console.log(
    `[ghost] run created id=${run.id} slug=${run.slug} tier=${tier} operator=${operator} ` +
      `uploaded=${targets.length} rejected=${rejected.length}`,
  );

  return NextResponse.json(
    { run, targets: targets.map((t) => t.phone), rejected, ...(warning ? { warning } : {}) },
    { status: 201 },
  );
}

export async function GET(request: NextRequest) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;
  if (!ghostPortalEnabled()) return notFound();

  const runs = await listGhostRuns(supabaseAdmin);
  return NextResponse.json({ runs });
}
