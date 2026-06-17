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
 *
 * Best-effort: if a page errors, the rows gathered so far are returned and the
 * error is logged (loud-over-silent), mirroring the analytics route's per-table
 * degrade-to-partial behaviour rather than failing the whole bundle.
 */
export async function fetchAllRows(
  client: SupabaseClient,
  table: string,
  columns: string,
  orderColumn = "id",
  eq?: { column: string; value: string },
  gte?: { column: string; value: string },
): Promise<Row[]> {
  const all: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    let query = client.from(table).select(columns);
    if (eq) query = query.eq(eq.column, eq.value);
    if (gte) query = query.gte(gte.column, gte.value);
    const { data, error } = await query
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error(`[fetchAllRows] ${table} page ${page} (from ${from}) failed:`, error);
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
