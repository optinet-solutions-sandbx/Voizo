// segmentPresence — resolve a campaign's stored Customer.io segment id against
// the live segment list, for the always-on edit page's Audience header.
//
// A campaign keeps its segment_id forever, but the segment itself can be
// deleted in Customer.io after the campaign was created. When that happens the
// daily spawn fails (deduped Slack alert, no calls that day). Surfacing it on
// the edit page lets the operator re-pick before the next run.

export interface SegmentLite {
  id: number;
  name: string;
}

/**
 * @param segmentId  the campaign's stored segment_id (null = no segment)
 * @param listOk     did the /api/customerio/segments fetch succeed?
 * @param segments   the live segment list (only meaningful when listOk)
 *
 * `missing` is true ONLY when the list loaded and the id is absent from it. A
 * FAILED fetch must never report missing — a false "no longer exists" alarm
 * would push the operator to re-pick a perfectly good segment.
 */
export function resolveSegmentPresence(
  segmentId: number | null,
  listOk: boolean,
  segments: SegmentLite[],
): { name: string | null; missing: boolean } {
  if (segmentId == null || !listOk) return { name: null, missing: false };
  const match = segments.find((s) => s.id === segmentId);
  return match ? { name: match.name, missing: false } : { name: null, missing: true };
}
