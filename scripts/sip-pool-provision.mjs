// SIP Pool Provisioning Script
// ============================================================
// Provisions the fixed pool of 5 SIP phone numbers on Vapi and
// registers them in vapi_sip_pool. Idempotent and dry-run by default.
//
// Run:
//   node --env-file=.env.local scripts/sip-pool-provision.mjs
//     -> dry-run, prints plan, makes zero side effects
//   node --env-file=.env.local scripts/sip-pool-provision.mjs --apply
//     -> creates missing slots on Vapi + DB
//
// Phase 1 step 4 of the SIP pool rollout. See:
//   docs/2026-05-08_DOC_SIP_Pool_Architecture.md
//   .agent/handoffs/2026-05-08_HANDOFF_SIP_Pool_Phase_0_Verification.md
//
// Design constraints:
//   - SIP authentication.username MUST be >= 20 chars (Vapi rule,
//     verified Phase 0 V2). Slot names are 22 chars by construction.
//   - Idle slots are created with no assistantId (Vapi accepts this,
//     verified Phase 0 V2; status: "active" is preserved).
//   - The script creates Vapi resource FIRST, then DB row. If the DB
//     INSERT fails after a successful Vapi POST, the orphan Vapi phone
//     ID is printed loudly so the operator can clean up before retry.
//     Re-running --apply will skip already-provisioned slots.
//   - No --decommission / --repair flags. Pool teardown is out of scope
//     for Phase 1 step 4.

import { createClient } from "@supabase/supabase-js";

// ── Configuration ────────────────────────────────────────────
const POOL_SIZE = 5;
const SLOT_NAME_PREFIX = "voizo-sip-pool-slot-";
const SIP_DOMAIN = "sip.vapi.ai";
const VAPI_BASE = "https://api.vapi.ai";

// ── CLI flag parsing ─────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const HELP = args.has("--help") || args.has("-h");

if (HELP) {
  console.log(`
SIP Pool Provisioning

Usage:
  node --env-file=.env.local scripts/sip-pool-provision.mjs [--apply]

Without --apply: dry-run, prints plan, makes zero side effects.
With --apply:    creates missing slots on Vapi + inserts DB rows.

The script is idempotent: re-running --apply after success makes no
new resources.
`);
  process.exit(0);
}

// ── Env validation ───────────────────────────────────────────
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_SIP_AUTH_PASSWORD = process.env.VAPI_SIP_AUTH_PASSWORD;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missing = [];
if (!VAPI_PRIVATE_KEY) missing.push("VAPI_PRIVATE_KEY");
if (!VAPI_SIP_AUTH_PASSWORD) missing.push("VAPI_SIP_AUTH_PASSWORD");
if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
if (!SUPABASE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
if (missing.length) {
  console.error(`FATAL: missing required env vars: ${missing.join(", ")}`);
  console.error("Run with: node --env-file=.env.local scripts/sip-pool-provision.mjs");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ──────────────────────────────────────────────────
const slotName = (i) => `${SLOT_NAME_PREFIX}${String(i).padStart(2, "0")}`;
const sipUriFor = (i) => `sip:${slotName(i)}@${SIP_DOMAIN}`;

const banner = (msg) => {
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n${msg}\n${bar}`);
};

const log = (...m) => console.log("[provision]", ...m);
const warn = (...m) => console.warn("[provision] WARN:", ...m);
const fail = (...m) => console.error("[provision] FAIL:", ...m);

const vapiFetch = async (method, path, body) => {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, raw: text };
};

// ── Phase 1: gather current state ───────────────────────────
banner(APPLY ? "SIP Pool Provisioning — APPLY MODE" : "SIP Pool Provisioning — DRY RUN");

log(`Pool size: ${POOL_SIZE}`);
log(`Slot naming: ${slotName(1)} … ${slotName(POOL_SIZE)}`);
log(`Mode: ${APPLY ? "APPLY (will create resources)" : "DRY-RUN (no side effects)"}`);

// 1a. Existing DB rows
log("Reading current vapi_sip_pool rows…");
const { data: dbRows, error: dbErr } = await supabase
  .from("vapi_sip_pool")
  .select("slot_index, sip_uri, sip_username, vapi_phone_number_id, status")
  .order("slot_index");

if (dbErr) {
  fail(`DB read failed: ${dbErr.message}`);
  process.exit(1);
}
log(`DB rows present: ${dbRows.length}`);

// 1b. Existing Vapi phone numbers (filter to slot prefix)
log("Reading current Vapi phone numbers…");
const phonesRes = await vapiFetch("GET", "/phone-number");
if (!phonesRes.ok) {
  fail(`Vapi phone-number list failed: HTTP ${phonesRes.status}`);
  fail(phonesRes.raw.slice(0, 300));
  process.exit(1);
}
const allPhones = Array.isArray(phonesRes.json) ? phonesRes.json : [];
const slotPhones = allPhones.filter((p) =>
  typeof p?.sipUri === "string" && p.sipUri.includes(SLOT_NAME_PREFIX),
);
log(`Vapi phone numbers total: ${allPhones.length}`);
log(`Vapi phone numbers matching slot prefix: ${slotPhones.length}`);

// ── Phase 2: build plan ─────────────────────────────────────
const dbBySlot = new Map(dbRows.map((r) => [r.slot_index, r]));
const phoneByUri = new Map(slotPhones.map((p) => [p.sipUri, p]));

const plan = [];
let inconsistencyDetected = false;

for (let i = 1; i <= POOL_SIZE; i++) {
  const sipUri = sipUriFor(i);
  const username = slotName(i);
  const dbRow = dbBySlot.get(i);
  const phoneRow = phoneByUri.get(sipUri);

  if (dbRow && phoneRow) {
    plan.push({ index: i, action: "SKIP", reason: "already provisioned (DB + Vapi)", dbRow, phoneRow });
  } else if (!dbRow && !phoneRow) {
    plan.push({ index: i, action: "CREATE", sipUri, username });
  } else if (dbRow && !phoneRow) {
    inconsistencyDetected = true;
    plan.push({
      index: i,
      action: "INCONSISTENT",
      reason: `DB row exists (vapi_phone_number_id=${dbRow.vapi_phone_number_id}) but no matching Vapi phone — Vapi resource was deleted out-of-band`,
      dbRow,
    });
  } else if (!dbRow && phoneRow) {
    inconsistencyDetected = true;
    plan.push({
      index: i,
      action: "INCONSISTENT",
      reason: `Vapi phone exists (id=${phoneRow.id}) but no matching DB row — DB row was deleted out-of-band`,
      phoneRow,
    });
  }
}

banner("Plan");
for (const item of plan) {
  if (item.action === "CREATE") {
    log(`  slot ${String(item.index).padStart(2, "0")}  CREATE   ${item.sipUri}`);
  } else if (item.action === "SKIP") {
    log(`  slot ${String(item.index).padStart(2, "0")}  SKIP     ${item.dbRow.sip_uri} (status=${item.dbRow.status})`);
  } else if (item.action === "INCONSISTENT") {
    warn(`  slot ${String(item.index).padStart(2, "0")}  INCONSISTENT — ${item.reason}`);
  }
}

const toCreate = plan.filter((p) => p.action === "CREATE");
const toSkip = plan.filter((p) => p.action === "SKIP");

banner("Summary");
log(`Slots to CREATE: ${toCreate.length}`);
log(`Slots to SKIP:   ${toSkip.length}`);
log(`Inconsistencies: ${inconsistencyDetected ? "YES — manual review required" : "none"}`);

if (inconsistencyDetected) {
  fail("Refusing to act with inconsistent state. Resolve manually and re-run.");
  fail("(Either delete the orphan resource, or re-add the missing one. No --repair flag yet.)");
  process.exit(2);
}

if (!APPLY) {
  banner("DRY RUN — no changes made. Re-run with --apply to execute.");
  process.exit(0);
}

if (toCreate.length === 0) {
  banner("Nothing to do. Pool is fully provisioned.");
  process.exit(0);
}

// ── Phase 3: APPLY ──────────────────────────────────────────
banner(`APPLY — creating ${toCreate.length} slot(s)`);

let created = 0;
let orphans = []; // Vapi phones successfully created but DB INSERT failed

for (const item of toCreate) {
  const { index, sipUri, username } = item;
  log(`Creating slot ${String(index).padStart(2, "0")} — ${sipUri}`);

  // 3a. Create Vapi phone number (no assistantId = idle slot)
  const createRes = await vapiFetch("POST", "/phone-number", {
    provider: "vapi",
    sipUri,
    name: username,
    authentication: { username, password: VAPI_SIP_AUTH_PASSWORD },
  });

  if (!createRes.ok) {
    fail(`Vapi POST failed for slot ${index}: HTTP ${createRes.status}`);
    fail(createRes.raw.slice(0, 500));
    fail(`Aborting. Created so far: ${created}/${toCreate.length}`);
    process.exit(3);
  }

  const phoneId = createRes.json?.id;
  if (!phoneId) {
    fail(`Vapi POST returned 2xx but no id in response for slot ${index}`);
    fail(createRes.raw.slice(0, 500));
    process.exit(3);
  }

  log(`  Vapi phone created: id=${phoneId}`);

  // 3b. Insert DB row
  const { error: insertErr } = await supabase.from("vapi_sip_pool").insert({
    slot_index: index,
    sip_uri: sipUri,
    sip_username: username,
    vapi_phone_number_id: phoneId,
    status: "free",
  });

  if (insertErr) {
    fail(`DB INSERT failed for slot ${index}: ${insertErr.message}`);
    fail(`ORPHAN VAPI PHONE: ${phoneId} (sipUri=${sipUri}) — must be deleted manually before retry`);
    orphans.push({ index, phoneId, sipUri });
    fail(`Aborting. Created so far: ${created}/${toCreate.length}`);
    break;
  }

  log(`  DB row inserted`);
  created++;
}

// ── Phase 4: report ─────────────────────────────────────────
banner("APPLY result");
log(`Created: ${created}/${toCreate.length}`);
if (orphans.length) {
  fail(`Orphan Vapi phone resources (DB INSERT failed AFTER Vapi POST succeeded):`);
  for (const o of orphans) {
    fail(`  slot ${o.index}: vapi_phone_number_id=${o.phoneId} sipUri=${o.sipUri}`);
    fail(`    Delete manually: curl -X DELETE ${VAPI_BASE}/phone-number/${o.phoneId} -H "Authorization: Bearer $VAPI_PRIVATE_KEY"`);
  }
  process.exit(4);
}

banner("Done. Pool is provisioned.");
process.exit(0);
