// Seed a REPAIRED version of the "Val - 20FS + 300% DB" script (VOZ-179).
//
// WHY: the original Val script repeats itself. Every collection box points at
// the SAME 11-member concern bank, five of whose members re-introduce
// "Victor from Lucky Seven" and four of which restate "I'll send the SMS
// anyway" — all worded differently, so the per-line observer never dedupes
// them. Core facts (20 spins / 300% bonus / SMS / today-only) are bundled into
// node statements and re-owed after every interruption.
//
// THE REPAIR:
//   • Atomic facts — free spins, bonus, and "SMS + today" are delivered once
//     each as their OWN proactive scenario beat (not re-bundled on every turn).
//   • Fact tags — every handler is tagged `fact:<key>`. With the observer
//     change (VOZ-177/178) a fact conveyed under ANY wording marks every
//     sibling line covered, so paraphrased re-pitches are suppressed and an
//     interruption-truncated line still counts as said.
//   • Identity/legitimacy live in the opening + ONE concern answer each — the
//     duplicate who-calling / where-from / scam members are collapsed.
//   • No catch-all bundle — a single consolidated concern bank answers
//     questions in place; a follow-up self-loop keeps the call in Q&A without
//     re-arming a fresh fact dump. Proper SMS-refusal and do-not-call off-ramps.
//
// SAFETY: additive + idempotent. Creates only rows tagged `valr-seed` plus a
// script/collection with the fixed names below; re-running deletes exactly
// those and rebuilds. It NEVER touches the original Val script or any other
// data. Writes to whatever DB .env.local points at (currently production —
// the script is inert until a campaign is launched against it).
//
// RUN (from repo root):  node scripts/seed-val-repaired.mjs
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) throw new Error("need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local");
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const SEED_TAG = "valr-seed";
const SCRIPT_NAME = "Val - Repaired (20FS + 300% DB)";
const COLLECTION_NAME = "Val - Repaired Concerns";

const die = (label, error) => { if (error) throw new Error(`${label}: ${error.message}`); };

// ── 1. idempotent cleanup: remove ONLY prior valr-seed artifacts ──────────
async function cleanup() {
  const { data: scripts } = await sb.from("listener_scripts").select("id").eq("name", SCRIPT_NAME);
  for (const s of scripts ?? []) {
    await sb.from("listener_script_edges").delete().eq("script_id", s.id);
    await sb.from("listener_script_nodes").delete().eq("script_id", s.id);
    await sb.from("listener_scripts").delete().eq("id", s.id);
  }
  const { data: cols } = await sb.from("listener_collections").select("id").eq("name", COLLECTION_NAME);
  for (const c of cols ?? []) {
    await sb.from("listener_collection_handlers").delete().eq("collection_id", c.id);
    await sb.from("listener_collections").delete().eq("id", c.id);
  }
  const { data: hs } = await sb.from("listener_handlers").select("id").contains("tags", [SEED_TAG]);
  const hids = (hs ?? []).map((h) => h.id);
  if (hids.length) {
    await sb.from("listener_collection_handlers").delete().in("handler_id", hids);
    await sb.from("listener_handlers").delete().in("id", hids);
  }
  console.log(`cleanup: removed ${scripts?.length ?? 0} script(s), ${cols?.length ?? 0} collection(s), ${hids.length} handler(s)`);
}

// ── 2. handlers (all tagged valr-seed + their fact keys) ──────────────────
async function handler(row) {
  const { data, error } = await sb
    .from("listener_handlers")
    .insert({ enabled: true, mode: "both", priority: 50, delivery: "reword", action_type: "answer", ...row })
    .select()
    .single();
  die("handler " + row.intent_key, error);
  return data;
}

async function main() {
  await cleanup();

  // Proactive fact beats — each fact delivered ONCE, tagged so it is never re-pitched.
  const hFreeSpins = await handler({
    name: "Val R - Free spins", intent_key: "valr_free_spins", tags: [SEED_TAG, "fact:free_spins"],
    description: "proactively reveal the twenty free spins",
    response_template: "So the reason I'm calling — I was going through your account and popped twenty free spins on there for you. Wanted to flag them since they do expire.",
  });
  const hBonus = await handler({
    name: "Val R - Bonus", intent_key: "valr_bonus", tags: [SEED_TAG, "fact:bonus"],
    description: "proactively reveal the 300% deposit bonus",
    response_template: "And on top of the spins, there's a three hundred percent bonus waiting on your next deposit.",
  });
  const hSmsToday = await handler({
    name: "Val R - SMS + today", intent_key: "valr_sms_today", tags: [SEED_TAG, "fact:sms", "fact:offer_window"],
    description: "confirm the SMS is coming and that the offer is only good today",
    response_template: "I'll text you the details so it's all in one place — and quick heads up, this one's only good for today.",
  });

  // Consolidated concern bank — ONE answer per concern, each tagged.
  const hWhoCalling = await handler({
    name: "Val R - Who is calling", intent_key: "valr_who_calling", tags: [SEED_TAG, "fact:identity"],
    description: "Player asks who is calling or which casino this is",
    response_template: "It's Victor, calling from Lucky Seven Casino.",
  });
  const hHowNumber = await handler({
    name: "Val R - How got number / legit", intent_key: "valr_how_got_number", tags: [SEED_TAG, "fact:legitimacy"],
    description: "Player asks how you got their number, or whether this is legit or a scam",
    response_template: "Your number's on file with your Lucky Seven account — that's where I've got it from. And once that text lands it'll confirm this is the real deal.",
  });
  const hCannotLogin = await handler({
    name: "Val R - Cannot login", intent_key: "valr_cannot_login", tags: [SEED_TAG, "fact:login_help"],
    description: "Player says they cannot log in or forgot their password",
    response_template: "Easiest fix there is live chat on the site — they'll get your login sorted in a couple of minutes.",
  });
  const hWagering = await handler({
    name: "Val R - Wagering", intent_key: "valr_wagering", tags: [SEED_TAG, "fact:wagering"],
    description: "Player asks about the wagering requirements",
    response_template: "Wagering's forty times, which is honestly on the low side — a good deal.",
  });
  const hSmsAnyway = await handler({
    name: "Val R - SMS anyway", intent_key: "valr_sms_anyway", tags: [SEED_TAG, "fact:sms_anyway"],
    description: "Player says they are not interested, or does not want the offer",
    response_template: "No worries at all — I'll still pop it in a text so it's there if you change your mind later.",
  });

  // Routing matchers (pure listeners: empty line, action ignore) — their
  // descriptions ARE the classifier vocabulary; the edges below listen for them.
  const mkMatcher = (intent_key, description) =>
    handler({ name: "Val R int - " + intent_key, intent_key, description, response_template: "", action_type: "ignore", delivery: "verbatim", mode: "listener", tags: [SEED_TAG] });
  const iFollowUp = await mkMatcher("valr_int_follow_up", "Player asks a follow-up question or wants to know more about the offer");
  const iWrapUp = await mkMatcher("valr_int_wrapping_up", "Player signals the call is wrapping up or ending (thanks, sounds good, got to go, bye)");
  const iRefuseSms = await mkMatcher("valr_int_refuse_sms", "Player explicitly refuses the SMS or says do not text me");
  const iDoNotCall = await mkMatcher("valr_int_do_not_call", "Player asks not to be called again or to be put on the do-not-call list");

  // Closes (reworded goodbyes; the engine speaks them then hangs up).
  const hEndWarm = await handler({
    name: "Val R - Warm close", intent_key: "valr_end_warm", tags: [SEED_TAG], action_type: "end_call",
    description: "warm, upbeat close",
    response_template: "Perfect — keep an eye out for that text, and good luck when you jump back in. Take care!",
  });
  const hEndDnc = await handler({
    name: "Val R - Do-not-call close", intent_key: "valr_end_dnc", tags: [SEED_TAG], action_type: "end_call",
    description: "respectful do-not-call close",
    response_template: "Understood — I've noted the number so we won't call again. I'll still send the text this once so you've got it. All the best!",
  });

  // ── 3. concern collection (attached to Q&A nodes -> global STANDING ANSWERS) ──
  const { data: col, error: colErr } = await sb
    .from("listener_collections")
    .insert({ name: COLLECTION_NAME, description: "Repaired, deduped concern answers for Val (one per fact, tagged)." })
    .select().single();
  die("collection", colErr);
  const concernIds = [hWhoCalling, hHowNumber, hCannotLogin, hWagering, hSmsAnyway].map((h) => h.id);
  die("collection_handlers", (await sb.from("listener_collection_handlers").insert(concernIds.map((handler_id) => ({ collection_id: col.id, handler_id })))).error);

  // ── 4. script graph ───────────────────────────────────────────────────────
  const { data: script, error: sErr } = await sb
    .from("listener_scripts")
    .insert({ name: SCRIPT_NAME, description: "Repaired Val 20FS+300% — atomic fact beats, one consolidated concern bank, fact-tagged (VOZ-179).", collection_id: col.id })
    .select().single();
  die("script", sErr);

  const conn = (intentKey) => (intentKey ? { id: "c:" + randomUUID(), intentKey } : { id: "c:" + randomUUID(), intentKey: "", any: true });
  const node = (type, label, config, scenario_id, y) => ({ id: randomUUID(), script_id: script.id, type, label, config, scenario_id: scenario_id ?? null, pos_x: 0, pos_y: y });
  const edge = (from, connector, to) => ({
    id: randomUUID(), script_id: script.id, source_node_id: from.id, target_node_id: to.id, label: "",
    condition: connector.any ? { kind: "any", handle: connector.id } : { kind: "intent", by: "intent", value: connector.intentKey, handle: connector.id },
  });

  // connectors
  const c1 = conn();                                   // start -> free spins
  const c2 = conn();                                   // free spins -> bonus
  const c3 = conn();                                   // bonus -> sms/today
  const c4any = conn(), c4refuse = conn("valr_int_refuse_sms"), c4dnc = conn("valr_int_do_not_call"); // sms/today -> ...
  const c5follow = conn("valr_int_follow_up"), c5wrap = conn("valr_int_wrapping_up"), c5dnc = conn("valr_int_do_not_call"), c5refuse = conn("valr_int_refuse_sms"), c5any = conn(); // Q&A -> ...
  const c6any = conn(), c6dnc = conn("valr_int_do_not_call"); // sms-denial -> ...

  const nStart = node("start", "Start call",
    { mode: "agent_first", opening: "Hey, Victor here from Lucky Seven — quick one, have you had a chance to log into your account lately?", openingDelivery: "reword", connectors: [c1] }, null, 0);
  const nFree = node("step", "Beat 1 — Free spins", { contentType: "scenario", connectors: [c2] }, hFreeSpins.id, 160);
  const nBonus = node("step", "Beat 2 — Bonus", { contentType: "scenario", connectors: [c3] }, hBonus.id, 320);
  const nSms = node("step", "Beat 3 — SMS + today", { contentType: "scenario", connectors: [c4any, c4refuse, c4dnc] }, hSmsToday.id, 480);
  const nQA = node("step", "Questions & wrap",
    { contentType: "collection", collectionId: col.id, statements: ["Ask, warmly, if there's anything they'd like to know before you let them go."], connectors: [c5follow, c5wrap, c5refuse, c5dnc, c5any] }, null, 640);
  const nSmsDenial = node("step", "SMS still sending",
    { contentType: "collection", collectionId: col.id, statements: ["Let them know you'll still send the text this once, just in case they change their mind — then ask if that sounds fair."], connectors: [c6any, c6dnc] }, null, 800);
  const nEndWarm = node("step", "Warm close", { contentType: "end" }, hEndWarm.id, 960);
  const nEndDnc = node("step", "Do-not-call close", { contentType: "end" }, hEndDnc.id, 960);

  const nodes = [nStart, nFree, nBonus, nSms, nQA, nSmsDenial, nEndWarm, nEndDnc];
  const edges = [
    edge(nStart, c1, nFree),
    edge(nFree, c2, nBonus),
    edge(nBonus, c3, nSms),
    edge(nSms, c4refuse, nSmsDenial),
    edge(nSms, c4dnc, nEndDnc),
    edge(nSms, c4any, nQA),
    edge(nQA, c5follow, nQA),        // follow-up self-loop: stay in Q&A, facts dedupe
    edge(nQA, c5wrap, nEndWarm),
    edge(nQA, c5refuse, nSmsDenial),
    edge(nQA, c5dnc, nEndDnc),
    edge(nQA, c5any, nEndWarm),
    edge(nSmsDenial, c6dnc, nEndDnc),
    edge(nSmsDenial, c6any, nEndWarm),
  ];

  die("nodes", (await sb.from("listener_script_nodes").insert(nodes)).error);
  die("edges", (await sb.from("listener_script_edges").insert(edges)).error);

  console.log("\n✅ Repaired Val script created");
  console.log("   script_id :", script.id);
  console.log("   name      :", SCRIPT_NAME);
  console.log("   collection:", col.id, `(${COLLECTION_NAME})`);
  console.log("   nodes     :", nodes.length, "| edges:", edges.length, "| handlers:", 15);
  console.log("\nFact tags in play: free_spins, bonus, sms, offer_window, identity, legitimacy, login_help, wagering, sms_anyway");
  console.log("Select it in the campaign wizard (Step 2 → Script) to launch a test.");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
