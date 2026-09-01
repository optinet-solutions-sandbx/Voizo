import { PREVIEW_HTML } from "./previewHtml";

/**
 * GET /audience/preview — the proposed Audience tab, as a frozen design preview.
 *
 * WHY THIS EXISTS (Jasiel, 2026-09-02): Maria and the CRM team need to see the face of the new
 * Audience tab in prod, without us freezing any design decision prematurely. So this ships the
 * CANONICAL MOCKUP byte-for-byte (plus a PREVIEW ribbon), on its own URL:
 *   - the real sidebar/navigation is untouched — the page paints its own, as part of the preview;
 *   - the numbers are a LIVE SNAPSHOT of production (2026-09-02 decision): computed by
 *     scripts/_gen-0902-audience-data.cjs at generation time — real players (identity unmasked,
 *     behind Basic Auth), real Mobivate receipts, real deposits — refreshed on request, and the
 *     ribbon states the computation time up top;
 *   - the existing /audience page (Lead Recycling) is untouched and unaffected.
 *
 * The HTML is a GENERATED module (previewHtml.ts) produced by
 * scripts/_gen-0902-audience-preview.cjs, which refuses to generate unless the mockup's own
 * contract gate passes AND the data engine's reconciliation checks pass. To refresh:
 *   node scripts/_gen-0902-audience-data.cjs && node scripts/_gen-0902-audience-preview.cjs
 * then commit. The preview can lag the design and the data, never diverge from either.
 *
 * Auth: the app-wide Basic Auth middleware covers this route (only /api/webhooks/*, /api/cron/*
 * and static assets are exempt), so the preview is exactly as private as the rest of the console.
 *
 * Cost: zero. Static string response; no DB, no provider calls, no client data fetches.
 */
export function GET(): Response {
  return new Response(PREVIEW_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A design preview must never be stale-cached into confusion after a regenerate+deploy,
      // and never CDN-cached past the Basic Auth boundary.
      "cache-control": "no-store",
    },
  });
}
