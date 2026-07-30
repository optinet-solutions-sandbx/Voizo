import type { SupabaseClient } from "@supabase/supabase-js";

// PostgREST caps an unpaginated .select() at the project's max-rows setting
// (default 1000). For client-side aggregation (the campaigns-list analytics) we
// need EVERY row, so we page through with .range() ordered by a stable key.
//
// Without this, reads of campaign_numbers_v2 (~1172 rows) and calls_v2 (~1256)
// silently truncated at 1000 — the newest campaigns' rows fell off the end, so
// the list showed 0 contacts/calls for them (and it would worsen as data grows).

type Row = Record<string, unknown>;

const PAGE_SIZE = 1000;
// Safety bound so a logic error can't loop forever: 100 pages = 100k rows. We
// loud-warn (never silently truncate) if a table ever legitimately exceeds it.
const MAX_PAGES = 100;

/**
 * Fetch ALL rows of a table (past the 1000-row cap) by paging .range() requests
 * ordered ascending by `orderColumn` (a stable unique key — defaults to "id").
 * The cap clamps EVERYTHING — measured 2026-07-30: `.range(0, 9999)` and
 * `limit=2000` both came back with exactly 1000 rows (`content-range:
 * 0-999/2058`) — so paging is the only way to read a full table, and any
 * explicit large range elsewhere is a false comfort.
 *
 * `eq` accepts one filter or an array of them (e.g. parent_campaign_id AND
 * status for the realtime queue read).
 *
 * Best-effort by default: if a page errors, the rows gathered so far are
 * returned and the error is logged (loud-over-silent), mirroring the analytics
 * route's per-table degrade-to-partial behaviour rather than failing the whole
 * bundle. Pass `opts.failFast` to THROW on a page error instead — for callers
 * where a partial result is itself a silent lie (CSV exports).
 */
export async function fetchAllRows(
  client: SupabaseClient,
  table: string,
  columns: string,
  orderColumn = "id",
  eq?: { column: string; value: string } | Array<{ column: string; value: string }>,
  gte?: { column: string; value: string },
  lt?: { column: string; value: string },
  opts?: { failFast?: boolean },
): Promise<Row[]> {
  const eqs = eq ? (Array.isArray(eq) ? eq : [eq]) : [];
  const all: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    let query = client.from(table).select(columns);
    for (const f of eqs) query = query.eq(f.column, f.value);
    if (gte) query = query.gte(gte.column, gte.value);
    if (lt) query = query.lt(lt.column, lt.value);
    const { data, error } = await query
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error(`[fetchAllRows] ${table} page ${page} (from ${from}) failed:`, error);
      if (opts?.failFast) {
        throw new Error(
          `fetchAllRows(${table}) page ${page} failed: ${(error as { message?: string }).message ?? "unknown"}`,
        );
      }
      break;
    }
    if (!data || data.length === 0) break;
    // Double-cast through unknown: with a non-literal `columns` string the
    // untyped Supabase client infers `data` as GenericStringError[] (see memory
    // supabase-select-single-literal). The rows are plain records at runtime.
    all.push(...(data as unknown as Row[]));
    if (data.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(
        `[fetchAllRows] ${table} hit MAX_PAGES=${MAX_PAGES} (${all.length} rows); results may be truncated.`,
      );
    }
  }
  return all;
}

/**
 * Display-order companion to fetchAllRows: paging must order by a UNIQUE key
 * (bulk inserts share created_at to the microsecond — the 2026-07-29 CA import
 * wrote 2k rows on one timestamp, and paging on a tied column skips/duplicates
 * rows at page boundaries), so callers fetch by id and re-apply their
 * created_at contract here. Stable (ties keep fetch order), null/unparseable
 * timestamps sort last in both directions, input is not mutated.
 */
export function sortRowsByCreatedAt(rows: Row[], direction: "asc" | "desc"): Row[] {
  const ms = (r: Row): number => {
    const t = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
    return Number.isFinite(t) ? t : NaN;
  };
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const am = ms(a);
    const bm = ms(b);
    if (Number.isNaN(am) && Number.isNaN(bm)) return 0;
    if (Number.isNaN(am)) return 1; // nulls last, regardless of direction
    if (Number.isNaN(bm)) return -1;
    return (am - bm) * sign;
  });
}
