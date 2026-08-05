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
  opts?: { failFast?: boolean; inFilter?: { column: string; values: readonly string[] } },
): Promise<Row[]> {
  const eqs = eq ? (Array.isArray(eq) ? eq : [eq]) : [];
  const all: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    let query = client.from(table).select(columns);
    for (const f of eqs) query = query.eq(f.column, f.value);
    // Small enumerated sets only (e.g. outcome IN (pending, pending_retry)) —
    // the values ride the URL, so a LARGE list belongs in fetchRowsIn instead.
    if (opts?.inFilter) query = query.in(opts.inFilter.column, [...opts.inFilter.values]);
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

// ── Parallel full-table read (read-path analytics ONLY) ─────────────────────
//
// fetchAllRows awaits its pages ONE AT A TIME, so a full-table read is N/1000
// SEQUENTIAL round-trips — and on Vercel→Supabase each hop is ~530ms, which is
// how /api/campaigns-v2/analytics hit 44s at 51k calls (52 serial hops; the
// 20MB payload itself turned out to be ~free — measured 2026-08-05).
// This variant counts first, then fires every page concurrently (POOL in
// flight), cutting wall time to ~ceil(pages/POOL) hops.
//
// READ-PATH ANALYTICS ONLY — never for dial-path decisions (resume /
// refresh-segment / duplicate stay on fetchAllRows): failure semantics differ
// (this THROWS; a parallel partial would have GAPS in the middle, which is
// worse than fetchAllRows' documented prefix-partial, so there is no
// best-effort mode here — callers catch and degrade explicitly), and firing
// POOL concurrent scans is a load pattern safety reads shouldn't adopt
// blindly. Same insert-race caveat as fetchAllRows: offset pages under
// concurrent INSERTs can skip/duplicate boundary rows; analytics reads accept
// this (shorter read window here actually narrows it). If the last page comes
// back exactly full, sequential tail pages extend past the initial count so
// rows inserted after the count aren't truncated.

const PARALLEL_POOL = 8;

/**
 * Fetch ALL rows of a table with concurrent pages. THROWS on a count error or
 * on any page that fails after one retry — never returns a gappy partial.
 */
export async function fetchAllRowsParallel(
  client: SupabaseClient,
  table: string,
  columns: string,
  orderColumn = "id",
): Promise<Row[]> {
  const { count, error: countErr } = await client
    .from(table)
    .select(orderColumn, { count: "exact", head: true });
  if (countErr) throw new Error(`fetchAllRowsParallel(${table}) count failed: ${countErr.message}`);
  const total = count ?? 0;
  if (total === 0) return [];

  const readPage = async (page: number): Promise<Row[]> => {
    const from = page * PAGE_SIZE;
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await client
        .from(table)
        .select(columns)
        .order(orderColumn, { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (!error) return (data ?? []) as unknown as Row[];
      console.error(`[fetchAllRowsParallel] ${table} page ${page} attempt ${attempt + 1} failed:`, error);
      if (attempt >= 1) {
        throw new Error(`fetchAllRowsParallel(${table}) page ${page} failed twice: ${error.message ?? "unknown"}`);
      }
    }
  };

  // Fixed page list from the count, drained by a small worker pool.
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages: Row[][] = new Array(pageCount);
  let next = 0;
  const worker = async () => {
    for (let p = next++; p < pageCount; p = next++) pages[p] = await readPage(p);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_POOL, pageCount) }, worker));

  const all = pages.flat();
  // Tail extension: rows inserted after the count call land past the last
  // offset (by count, not key order — but a FULL last page is the signal more
  // may exist either way). Sequential from here; the tail is at most a page or two.
  if (pages[pageCount - 1].length === PAGE_SIZE) {
    for (let p = pageCount; p < pageCount + MAX_PAGES; p++) {
      const tail = await readPage(p);
      all.push(...tail);
      if (tail.length < PAGE_SIZE) break;
    }
  }
  return all;
}

// ── .in() list chunking ─────────────────────────────────────────────────────
//
// The row-count clamp is not the only PostgREST limit: an .in() filter rides
// the request URL, and our own HTTP client refuses large ones — measured
// 2026-07-30: 1,000 phones (15.7KB of URL) throws UND_ERR_HEADERS_OVERFLOW
// before the request leaves; 2,100 draws a 400 from the edge; 500 still
// passes. Chunk size 200 is the proven-margin precedent (theme drill-down).
// supabase-js swallows the throw into { data: null, error }, so an unchecked
// call site reads `.data ?? []` and gets a silently-EMPTY result — which is
// how the resume/duplicate safety buckets reported "0 suppressed, 0 DNC" on
// large campaigns. These helpers chunk the list and refuse to be silent.

const IN_CHUNK = 200;

/** The filter methods a per-chunk query builder must offer. The real
 *  supabase-js builder satisfies this structurally. */
export interface ChunkFilterable {
  eq(column: string, value: unknown): ChunkFilterable;
  neq(column: string, value: unknown): ChunkFilterable;
  gt(column: string, value: unknown): ChunkFilterable;
  in(column: string, values: readonly unknown[]): ChunkFilterable;
}

/**
 * SELECT rows where `inColumn` is in `values`, chunked at 200 per request.
 * `applyFilters` re-applies any extra .eq/.neq/.gt/.in on every chunk.
 * THROWS on any chunk error — for safety-bucket reads (suppression, DNC,
 * overlap), a partial or empty result is exactly the lie being fixed.
 * Each chunk returns at most 200 rows, so the row clamp cannot bite either.
 */
export async function fetchRowsIn(
  client: SupabaseClient,
  table: string,
  columns: string,
  inColumn: string,
  values: readonly string[],
  applyFilters?: (q: ChunkFilterable) => ChunkFilterable,
): Promise<Row[]> {
  const all: Row[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    let q = client.from(table).select(columns) as unknown as ChunkFilterable;
    if (applyFilters) q = applyFilters(q);
    // The chunked in-filter goes LAST so applyFilters cannot displace it.
    const { data, error } = await (q.in(inColumn, chunk) as unknown as PromiseLike<{
      data: Row[] | null;
      error: { message?: string } | null;
    }>);
    if (error) {
      throw new Error(`fetchRowsIn(${table}) chunk at ${i} failed: ${error.message ?? "unknown"}`);
    }
    all.push(...(data ?? []));
  }
  return all;
}

/**
 * UPDATE rows where `inColumn` is in `values`, chunked at 200 per request.
 * Continues past a failed chunk (loud-logged, reported in `errors`) so one
 * bad batch doesn't strand the rest — the CALLER owns the partial-state
 * response policy. `count` sums the rows each successful chunk touched.
 */
export async function updateRowsIn(
  client: SupabaseClient,
  table: string,
  patch: Row,
  inColumn: string,
  values: readonly string[],
  applyFilters?: (q: ChunkFilterable) => ChunkFilterable,
): Promise<{ count: number; errors: Array<{ at: number; message: string }> }> {
  let count = 0;
  const errors: Array<{ at: number; message: string }> = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const chunk = values.slice(i, i + IN_CHUNK);
    let q = client.from(table).update(patch, { count: "exact" }) as unknown as ChunkFilterable;
    if (applyFilters) q = applyFilters(q);
    const { error, count: chunkCount } = await (q.in(inColumn, chunk) as unknown as PromiseLike<{
      error: { message?: string } | null;
      count: number | null;
    }>);
    if (error) {
      console.error(`[updateRowsIn] ${table} chunk at ${i} failed:`, error);
      errors.push({ at: i, message: error.message ?? "unknown" });
      continue;
    }
    count += chunkCount ?? 0;
  }
  return { count, errors };
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
