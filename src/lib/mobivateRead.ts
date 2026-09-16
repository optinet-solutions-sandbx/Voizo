// Mobivate's READ side (2026-09-07): the message history and the opt-out list, both plain GETs on
// the same key that sends (MOBIVATE_API_KEY on MOBIVATE_API_HOST, scopes View/Download Message
// History and List Opt-Outs). Docs: https://wiki.mobivatebulksms.com/llms.txt (message-history,
// optouts-management). Nothing here sends or costs; a throw is the only failure signal, the cron
// route decides what a throw means. Paging is asserted against Mobivate's own `matches` / `total`
// so a partial pull can never pass as a complete one.

const PAGE = 5000; // accepted in the 2026-09-07 probe: 5,000 records in one answer, ~10 s

export interface MobivateHistoryRecord {
  id: string;
  reference: string | null;
  status: string;
  price: number | null;
  currency: string | null;
  parts: number | null;
  created_at: string;
  updated_at: string;
}

export interface MobivateOptoutRecord {
  msisdn: string;
  created_on: string | null;
  note: string | null;
  group: string | null;
}

/** "YYYY-MM-DD" of a UTC instant shifted by whole days. Mobivate's date filters are calendar days. */
export function utcDate(ms: number, addDays = 0): string {
  return new Date(ms + addDays * 86_400_000).toISOString().slice(0, 10);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

async function getJson(path: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const host = process.env.MOBIVATE_API_HOST;
  const key = process.env.MOBIVATE_API_KEY;
  if (!host || !key) throw new Error("MOBIVATE_API_HOST / MOBIVATE_API_KEY not set");
  const res = await fetchImpl(`https://${host}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON body: reported below */ }
  if (!res.ok) throw new Error(`Mobivate ${res.status} on ${path}: ${str(body.error) ?? str(body.message) ?? text.slice(0, 200)}`);
  return body;
}

/** Mobivate outbound records for [fromDate, toDate], NARROWED to the given originators.
 *
 *  VOZ-534: the filter is not an optimisation, it is what makes this callable at all. The API key
 *  is on a SHARED Mobivate account, so an unfiltered 4-day window matched 179,583 records on
 *  2026-09-16 - 36 pages at 7.6-18.2 s each, 274-407 s against the route maxDuration of 300. Our
 *  own rows in that same window numbered 111. Narrowing to the three sender ids we actually use
 *  cut it to 85,183 records / 18 pages / 137-204 s. Measured, not estimated.
 *
 *  `limit` is capped at 5,000 by the provider: 10,000 and 20,000 both answer HTTP 502, so PAGE
 *  cannot be raised to buy headroom.
 *
 *  The originator match is EXACT and case-insensitive (probed 2026-09-16: Lucky7even / lucky7even
 *  / LUCKY7EVEN all return the same count, "Lucky7" is a DIFFERENT originator with 23, and
 *  "Lucky7evenZZZ" returns 0). So casing drift between our sender_id and Mobivate cannot silently
 *  zero a brand - but an originator we have never sent from still returns a clean 0, which reads
 *  exactly like "nothing to do". The caller must pair this with a must-be-positive control; this
 *  function cannot, it does not know how many rows we expect.
 *
 *  Pad toDate by a day: the filter left out the last UTC hours of the named day in the 2026-09-07
 *  probe, and a same-day fromDate/toDate returns 0 (probed 2026-09-16), so the end is exclusive. */
export async function fetchMessageHistory(
  fromDate: string,
  toDate: string,
  originators: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<MobivateHistoryRecord[]> {
  const out: MobivateHistoryRecord[] = [];
  for (const originator of originators) {
    let expected: number | null = null;
    let read = 0;
    for (let offset = 0; ; offset += PAGE) {
      const body = await getJson(
        `/messages/history?fromDate=${fromDate}&toDate=${toDate}&limit=${PAGE}&offset=${offset}&originator=${encodeURIComponent(originator)}`,
        fetchImpl,
      );
      const results = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : null;
      if (!results) throw new Error(`Mobivate history: no results array (keys ${Object.keys(body).join(",")})`);
      if (expected === null) expected = num(body.matches);
      read += results.length;
      for (const r of results) {
        out.push({
          id: String(r.id ?? ""),
          reference: str(r.reference),
          status: String(r.status ?? "").toUpperCase(),
          price: num(r.price),
          currency: str(r.currency),
          parts: num(r.parts),
          created_at: String(r.created_at ?? ""),
          updated_at: String(r.updated_at ?? ""),
        });
      }
      if (results.length < PAGE) break;
    }
    // `read < expected` is truncation and must fail. `read > expected` is GROWTH and must not: the
    // account sends constantly, so new records land while we page and the total moves under us.
    // The old `!==` could only ever fail on a live feed - it read 240,927 of 240,926 on
    // 2026-09-15, which is why this job had never once completed.
    if (expected !== null && read < expected) {
      throw new Error(`Mobivate history[${originator}]: read ${read} of ${expected} records`);
    }
  }
  return out;
}

/** The whole Mobivate opt-out list (STOP replies, the "3x UNDELIVERABLE" rule, CRM pastes).
 *
 *  VOZ-534: every field name below was wrong, because this half of the file had its unit fixture
 *  INVENTED from the docs ({success, records, total}) while the history half had its fixture
 *  CAPTURED from the real API. Only the invented one was broken, and it kept the suite green while
 *  the job 500ed every night. The real body, captured 2026-09-16:
 *  {type, results, scanned, matches, offset, limit}, records keyed
 *  {userID, msisdn, note, created_at, updated_at, id, group}.
 *    body.records -> body.results   the array; this is the error the first dry run printed
 *    body.total   -> body.matches   there is NO `total` key, so the completeness assertion below
 *                                   would have been skipped SILENTLY once the array was found
 *    r.created_on -> r.created_at   there is NO `created_on`, so listed_at was NULL on every row */
export async function fetchOptouts(fetchImpl: typeof fetch = fetch): Promise<MobivateOptoutRecord[]> {
  const out: MobivateOptoutRecord[] = [];
  let expected: number | null = null;
  for (let offset = 0; ; offset += PAGE) {
    const body = await getJson(`/addressbook/optouts?limit=${PAGE}&offset=${offset}`, fetchImpl);
    const results = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : null;
    if (!results) throw new Error(`Mobivate optouts: no results array (keys ${Object.keys(body).join(",")})`);
    if (expected === null) expected = num(body.matches);
    for (const r of results) out.push({ msisdn: String(r.msisdn ?? ""), created_on: str(r.created_at), note: str(r.note), group: str(r.group) });
    if (results.length < PAGE) break;
  }
  // Same `<` rather than `!==` as the history leg, and for the same reason: STOP replies arrive
  // while we page, so this total grows under us too. Truncation still fails loudly; growth does not.
  if (expected !== null && out.length < expected) throw new Error(`Mobivate optouts: read ${out.length} of ${expected} records`);
  return out;
}
