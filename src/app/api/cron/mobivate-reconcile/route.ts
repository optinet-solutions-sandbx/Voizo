import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { CRON_NAMES, recordHeartbeat } from "@/lib/alerts/slack";
import { fetchMessageHistory, fetchOptouts, utcDate } from "@/lib/mobivateRead";
import { classifyOptout, normalizeMsisdn, planSmsUpdate, staleDeleteAllowed } from "@/lib/mobivateReconcile";

/**
 * Nightly Mobivate reconcile (2026-09-07). Two reads from Mobivate, writes only to our tables:
 *   1. /addressbook/optouts -> mobivate_optouts mirror (upsert, then a guarded stale sweep);
 *      player_opt_out rows also go to suppression_list (consent record; stops calls too).
 *   2. /messages/history for the last 3 UTC days (+1 day padding: Mobivate's toDate leaves out
 *      the last hours of the named day) -> close our 'sent'/'queued' rows to the final word,
 *      keep price/parts on every matched row.
 * Query: from=YYYY-MM-DD&to=YYYY-MM-DD (backfill window), dry=1 (write nothing), skipOptouts=1.
 * Cost: zero Vapi/SquareTalk/Mobivate (GETs are free). Runtime: ~15 s per 9k records.
 */
export const maxDuration = 300;

const LOOKBACK_DAYS = 3;
const UPSERT_CHUNK = 500;
const READ_PAGE = 1000; // PostgREST clamps every answer at 1,000 rows

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[mobivate-reconcile] CRON_SECRET not set — rejecting");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  const expected = `Bearer ${cronSecret}`;
  const received = request.headers.get("authorization") || "";
  if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams;
  const dry = q.get("dry") === "1";
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = DATE.test(q.get("from") ?? "") ? (q.get("from") as string) : utcDate(now, -LOOKBACK_DAYS);
  const to = DATE.test(q.get("to") ?? "") ? (q.get("to") as string) : utcDate(now, 1);

  // ── 1. opt-out mirror ──
  const optouts = { pulled: 0, upserted: 0, deleted: 0, suppressed: 0, byKind: {} as Record<string, number>, error: null as string | null };
  if (q.get("skipOptouts") !== "1") {
    try {
      const list = await fetchOptouts();
      optouts.pulled = list.length;
      const rows: { phone_e164: string; listed_at: string | null; reason: string | null; kind: string; synced_at: string }[] = [];
      const seen = new Set<string>();
      for (const o of list) {
        const phone = normalizeMsisdn(o.msisdn);
        if (!phone || seen.has(phone)) continue; // a malformed or duplicate msisdn is skipped, never written
        seen.add(phone);
        const kind = classifyOptout(o.note);
        optouts.byKind[kind] = (optouts.byKind[kind] ?? 0) + 1;
        rows.push({ phone_e164: phone, listed_at: o.created_on, reason: o.note, kind, synced_at: nowIso });
      }
      // Capture the error: without it a failed count leaves `previous` null, `previous ?? 0` makes it 0, and
      // staleDeleteAllowed(0, n) returns true for any non-empty pull — the 90% guard would pass exactly when
      // it is needed and the sweep would delete the whole mirror.
      const { count: previous, error: countErr } = await supabaseAdmin.from("mobivate_optouts").select("phone_e164", { count: "exact", head: true });
      if (countErr) throw new Error(`held count: ${countErr.message}`);
      if (!dry) {
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
          const { error } = await supabaseAdmin.from("mobivate_optouts").upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "phone_e164" });
          if (error) throw new Error(`upsert: ${error.message}`);
          optouts.upserted += Math.min(UPSERT_CHUNK, rows.length - i);
        }
        if (staleDeleteAllowed(previous ?? 0, rows.length)) {
          const { data: gone, error } = await supabaseAdmin.from("mobivate_optouts").delete().lt("synced_at", nowIso).select("phone_e164");
          if (error) throw new Error(`stale sweep: ${error.message}`);
          optouts.deleted = gone?.length ?? 0;
        } else {
          console.error(`[mobivate-reconcile] stale sweep SKIPPED: pulled ${rows.length} vs held ${previous ?? 0} (a short pull must not un-block anyone)`);
        }
        // Consent records: a player who tapped the opt-out link goes on our suppression list too.
        const players = rows.filter((r) => r.kind === "player_opt_out").map((r) => ({ phone_e164: r.phone_e164, reason: "mobivate_opt_out", added_by: "mobivate-reconcile" }));
        for (let i = 0; i < players.length; i += UPSERT_CHUNK) {
          const { error } = await supabaseAdmin.from("suppression_list").upsert(players.slice(i, i + UPSERT_CHUNK), { onConflict: "phone_e164", ignoreDuplicates: true });
          if (error) throw new Error(`suppression_list: ${error.message}`);
        }
        optouts.suppressed = players.length;
      } else {
        optouts.suppressed = rows.filter((r) => r.kind === "player_opt_out").length;
      }
    } catch (e) {
      optouts.error = e instanceof Error ? e.message : String(e);
      console.error("[mobivate-reconcile] optouts:", optouts.error);
    }
  }

  // ── 2. message history ──
  const history = { records: 0, ours: 0, originators: [] as string[], unfilterable: 0, updated: 0, flipped: { delivered: 0, undelivered: 0, failed: 0 }, unmappedWords: [] as string[], error: null as string | null };
  try {
    // VOZ-534: OUR rows are read FIRST now, because they are what tells us which originators to ask
    // Mobivate for. Unfiltered, a 4-day window is 179,583 records of the SHARED account (36 pages,
    // 274-407 s) against maxDuration 300 — measured 2026-09-16, and it had never once finished.
    // Our own rows in that window: 111. Deriving the list from sender_id rather than hard-coding the
    // three brands is deliberate: a hard-coded list is exactly how voicemail_autohangup drifted off
    // for a whole brand three times. A fourth brand starts reconciling the day it first sends.
    const ours: { id: string; status: string; created_at: string; provider_message_id: string | null; sender_id: string | null }[] = [];
    for (let p = 0; ; p++) {
      const { data, error } = await supabaseAdmin
        .from("sms_messages_v2")
        .select("id, status, created_at, provider_message_id, sender_id")
        .gte("created_at", `${utcDate(Date.parse(`${from}T00:00:00Z`), -1)}T00:00:00Z`)
        .lte("created_at", `${to}T23:59:59Z`)
        .order("id")
        .range(p * READ_PAGE, p * READ_PAGE + READ_PAGE - 1);
      if (error) throw new Error(`sms read: ${error.message}`);
      ours.push(...(data ?? []));
      if ((data ?? []).length < READ_PAGE) break;
    }
    history.ours = ours.length;

    // Rows with no sender_id cannot be narrowed to an originator, so they cannot be reconciled by
    // this path. All 1,853 such rows predate 2026-07-31, so a normal nightly window has none — but
    // a BACKFILL over older dates would silently under-reconcile, and silence is the failure mode
    // this whole ticket is about. Surfaced in the response and logged, never swallowed.
    const originators = [...new Set(ours.map((r) => r.sender_id).filter((x): x is string => !!x))].sort();
    history.originators = originators;
    history.unfilterable = ours.filter((r) => !r.sender_id).length;
    if (history.unfilterable > 0) {
      console.error(`[mobivate-reconcile] ${history.unfilterable} of ${ours.length} rows have no sender_id and were NOT reconciled (pre-2026-07-31 rows)`);
    }

    // No rows of ours in the window = nothing to reconcile. Skip the pull entirely rather than page
    // 179k records of someone else's traffic to discover that.
    const recs = originators.length ? await fetchMessageHistory(from, to, originators) : [];
    history.records = recs.length;

    // MUST-BE-POSITIVE CONTROL. An originator Mobivate does not recognise returns a clean, cheerful
    // 0 — indistinguishable from "nothing to do" — and this job's entire history is of failing
    // quietly. If we hold rows for a sender in this window, Mobivate must hold at least one too.
    // Throwing here blocks the heartbeat, which is the point: a reconcile that reconciles nothing
    // must not report success. Coarse on purpose — MobivateHistoryRecord carries no originator
    // field, so this catches the whole-pull zero rather than one brand of three going quiet.
    // ponytail: per-brand attribution needs `originator` on the record; add it if a brand ever
    // drops out unnoticed.
    if (originators.length > 0 && recs.length === 0) {
      throw new Error(
        `Mobivate history returned 0 records for ${ours.length} of our rows across originators ` +
          `[${originators.join(", ")}] in ${from}..${to}. An unrecognised originator returns 0, ` +
          `so this is a filter fault, not an empty night.`,
      );
    }

    const byRef = new Map<string, (typeof recs)[number]>();
    const byId = new Map<string, (typeof recs)[number]>();
    for (const r of recs) { if (r.reference) byRef.set(r.reference.toLowerCase(), r); if (r.id) byId.set(r.id.toLowerCase(), r); }
    const unmapped = new Set<string>();
    for (const row of ours) {
      const rec = byRef.get(row.id.toLowerCase()) ?? (row.provider_message_id ? byId.get(row.provider_message_id.toLowerCase()) : undefined);
      if (!rec) continue;
      const { update, unmappedWord } = planSmsUpdate(row, rec, nowIso);
      if (unmappedWord) unmapped.add(unmappedWord);
      if (!update) continue;
      if (!dry) {
        const { error } = await supabaseAdmin.from("sms_messages_v2").update(update).eq("id", row.id);
        if (error) throw new Error(`sms update ${row.id}: ${error.message}`);
      }
      history.updated++;
      if (update.status) history.flipped[update.status as keyof typeof history.flipped]++;
    }
    history.unmappedWords = [...unmapped];
    if (unmapped.size) console.error(`[mobivate-reconcile] unmapped Mobivate words, rows left open: ${[...unmapped].join(", ")}`);
  } catch (e) {
    history.error = e instanceof Error ? e.message : String(e);
    console.error("[mobivate-reconcile] history:", history.error);
  }

  if (!dry && !optouts.error && !history.error) await recordHeartbeat(supabaseAdmin, CRON_NAMES.mobivateReconcile);
  const ok = !optouts.error && !history.error;
  console.log(`[mobivate-reconcile] ${dry ? "DRY " : ""}${from}..${to} optouts=${optouts.pulled}/${optouts.upserted}/-${optouts.deleted} history=${history.records} originators=[${history.originators.join(",")}] ours=${history.ours} unfilterable=${history.unfilterable} updated=${history.updated} flipped=${JSON.stringify(history.flipped)}`);
  return NextResponse.json({ ok, dry, window: { from, to }, optouts, history }, { status: ok ? 200 : 500 });
}
