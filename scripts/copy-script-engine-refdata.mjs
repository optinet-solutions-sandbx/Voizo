// Copy Script Engine reference data (Playbook) from the source app's Supabase
// into voizo-sandbox. VOZ-148 (plan §1.2 "Reference data").
//
// Reads (anon, read-only) from the source project and writes (service role) to
// the destination, in FK order:
//   listener_handlers -> listener_collections -> listener_collection_handlers
//   -> listener_scripts -> listener_script_nodes -> listener_script_edges
// Skips per-call history (lab_call_events / lab_call_flow_state) and the
// builder singleton (lab_settings) — those are not reference data.
//
// PREREQUISITE: run supabase-migration-script-engine.sql on the destination
// FIRST (the tables must exist).
//
// Usage (PowerShell):
//   $env:VOIZO_SUPABASE_URL="https://<voizo-sandbox>.supabase.co"
//   $env:VOIZO_SERVICE_ROLE_KEY="<service-role-key>"
//   node scripts/copy-script-engine-refdata.mjs            # apply
//   node scripts/copy-script-engine-refdata.mjs --dry-run  # counts only, no writes
//
// Idempotent: upsert on primary key, so re-running reconciles rather than
// duplicating. Safe to run repeatedly.

import { createClient } from "@supabase/supabase-js";

// Source = the source app's Supabase. Anon key is publishable + read-only here
// (same key hardcoded in the source repo's lib/supabase.ts); reference data is
// world-readable via the permissive RLS. Override with SRC_* env if it moves.
const SRC_URL = process.env.SRC_SUPABASE_URL || "https://mfnebrospbqhbrxfexie.supabase.co";
const SRC_ANON = process.env.SRC_SUPABASE_ANON_KEY || "sb_publishable_0CSebHk0k2ToTg7-F4KeDA_ZjRpz7q5";

const DEST_URL = process.env.VOIZO_SUPABASE_URL;
const DEST_KEY = process.env.VOIZO_SERVICE_ROLE_KEY;

const DRY_RUN = process.argv.includes("--dry-run");

// Destination creds are only needed to write; --dry-run reads source only.
if (!DRY_RUN && (!DEST_URL || !DEST_KEY)) {
  console.error(
    "FATAL: set VOIZO_SUPABASE_URL and VOIZO_SERVICE_ROLE_KEY (destination voizo-sandbox).\n" +
      "The service-role key is required to write past RLS. (Use --dry-run to preview counts without writing.)"
  );
  process.exit(1);
}

const src = createClient(SRC_URL, SRC_ANON, { auth: { persistSession: false } });
const dest = DRY_RUN ? null : createClient(DEST_URL, DEST_KEY, { auth: { persistSession: false } });

// FK order — parents before children. conflictKey = primary key(s) for upsert.
const TABLES = [
  { name: "listener_handlers", conflictKey: "id" },
  { name: "listener_collections", conflictKey: "id" },
  { name: "listener_collection_handlers", conflictKey: "collection_id,handler_id" },
  { name: "listener_scripts", conflictKey: "id" },
  { name: "listener_script_nodes", conflictKey: "id" },
  { name: "listener_script_edges", conflictKey: "id" },
];

async function readAll(table) {
  // Page through in case a table is larger than the default 1000-row cap.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await src.from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function run() {
  console.log(`Source:      ${SRC_URL}`);
  console.log(`Destination: ${DEST_URL}`);
  console.log(DRY_RUN ? "Mode:        DRY RUN (no writes)\n" : "Mode:        APPLY\n");

  let total = 0;
  for (const { name, conflictKey } of TABLES) {
    const rows = await readAll(name);
    total += rows.length;
    if (DRY_RUN) {
      console.log(`  ${name}: ${rows.length} rows (would upsert)`);
      continue;
    }
    if (rows.length === 0) {
      console.log(`  ${name}: 0 rows — skipped`);
      continue;
    }
    // Chunk to keep payloads reasonable.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { error } = await dest.from(name).upsert(slice, { onConflict: conflictKey });
      if (error) throw new Error(`upsert ${name}: ${error.message}`);
    }
    console.log(`  ${name}: ${rows.length} rows upserted`);
  }
  console.log(`\nDone. ${total} rows ${DRY_RUN ? "counted" : "copied"} across ${TABLES.length} tables.`);
}

run().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
