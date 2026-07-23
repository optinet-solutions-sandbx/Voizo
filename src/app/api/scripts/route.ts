// GET /api/scripts — lists Script Engine scripts for the Add-Campaign wizard's
// Script-mode dropdown (VOZ-159). Behind Basic Auth (operator-only) like the
// rest of the dashboard. Reads via the ported engine's anon client.
import { NextResponse } from "next/server";
import { listScripts } from "@/lib/scriptEngine/lab-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const scripts = await listScripts();
    return NextResponse.json({
      // Hide per-campaign script copies (named "… — campaign: …" by the launch
      // path, VOZ-160) so operators only pick ORIGINAL scripts as a base.
      // TODO(VOZ-169): replace this naming-convention filter with a proper
      // is_campaign_copy flag column.
      scripts: scripts
        .filter((s) => !/ — campaign: /.test(s.name))
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          // VOZ-188: the wizard previews the script's persona read-only.
          // `?? ""` guards rows read before the persona migration ran.
          persona: s.persona ?? "",
          updatedAt: s.updated_at,
        })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list scripts" },
      { status: 500 },
    );
  }
}
