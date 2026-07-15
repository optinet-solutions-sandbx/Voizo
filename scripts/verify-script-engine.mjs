// End-to-end verification of the Script Engine (brief-ahead runtime).
// This harness caught every serverless bug this engine ever had — unit
// tests alone never did. Keep the end-to-end shape when porting.
//
// HOW TO RUN (from the repo root):
//   1. OPENAI_BASE_URL=http://127.0.0.1:45871/v1 OPENAI_API_KEY=mock-key \
//        npx next dev -p 3987
//   2. node scripts/verify-script-engine.mjs
//
// The script starts an in-process mock OpenAI router (:45871, canned
// intents keyed on magic phrases like "affirmative dolphin") and a VAPI
// control-URL stub (:45872, captures say / add-message / end-call). It
// drives the dev server with synthetic VAPI webhook posts, asserts on
// lab_call_events rows + captured control messages, and cleans up every
// temp row (tmp_-prefixed handlers/scripts/collections) in `finally`.
// It runs against the REAL shared DB — cleanup matters; don't kill it
// mid-run without re-running so cleanup can finish.
//
// Coverage (42 assertions):
//  B1-B7  brief-ahead core: routed turns inject NO spoken line — only one
//         non-triggering [CURRENT STAGE] menu; menu rendering (members,
//         word-for-word marks, else ladder, statement riders); stage
//         advance; watchdog stands down on model-side turns; exact goodbye
//         engine-spoken with hangup attached; reworded goodbye model-side
//         with watchdog hangup; reactive Playbook suppressed on scripts
//  G1-G4  backchannel gate (noise never advances; real replies do),
//         universal stage fallback, held-turn visibility
//  W1-W4  Wait box: silence path fires once after waitSeconds via the poll
//         clock, never prematurely, never twice; menus exclude silence paths
//  O1-O3  observer pass: covered lines marked (never removed), skipped
//         statements return as Still-OWED debts, paid debts disappear
//  R1-R2  interruption arbiter: noise that cut the agent off triggers a
//         resume nudge; late noise does not
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

// Voizo adaptation: read creds from .env.local (the DB the dev server uses),
// NOT the source app's hardcoded project. The harness seeds/reads/cleans up
// with the SERVICE ROLE so it works regardless of RLS. Basic Auth is sent on
// /api/lab/* because Voizo gates those routes (source app did not).
const env = {};
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.error("FATAL: could not read .env.local (run from repo root).");
  process.exit(1);
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL + a Supabase key must be set in .env.local.");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });
const BASIC_AUTH =
  env.DASHBOARD_USERNAME && env.DASHBOARD_PASSWORD
    ? "Basic " + Buffer.from(`${env.DASHBOARD_USERNAME}:${env.DASHBOARD_PASSWORD}`).toString("base64")
    : null;
const authHeaders = BASIC_AUTH ? { Authorization: BASIC_AUTH } : {};

const APP = "http://127.0.0.1:3987";
const CONTROL = "http://127.0.0.1:45872/control";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock OpenAI router ────────────────────────────────────────
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let utterance = "";
      try {
        const j = JSON.parse(body);
        const user = (j.messages ?? []).filter((m) => m.role === "user").pop();
        utterance = (/Customer utterance: "([\s\S]*)"\s*$/.exec(user?.content ?? "")?.[1] ?? "").toLowerCase();
      } catch {}
      const cls = utterance.includes("affirmative dolphin")
        ? { intent: "tmp_yes_reply", confidence: 0.96 }
        : utterance.includes("purple bonus")
        ? { intent: "tmp_m1", confidence: 0.95 }
        : utterance.includes("crimson falcon")
        ? { intent: "tmp_side", confidence: 0.95 }
        : { intent: "none", confidence: 0.2 };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "mock", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(cls) }, finish_reason: "stop" }] }));
    });
  })
  .listen(45871);

// ── VAPI control stub ─────────────────────────────────────────
let controlMsgs = [];
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { controlMsgs.push(JSON.parse(body)); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  })
  .listen(45872);

// ── webhook helpers ───────────────────────────────────────────
async function post(msg, callId) {
  const r = await fetch(`${APP}/api/lab/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ message: { ...msg, call: { id: callId, monitor: { controlUrl: CONTROL } } } }),
  });
  if (!r.ok) throw new Error(`webhook ${r.status}`);
}
const say = (callId, transcript, role = "user") => post({ type: "transcript", role, transcriptType: "final", transcript }, callId);
const watch = (callId) => fetch(`${APP}/api/lab/watch`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ callId }) });
async function events(callId) {
  const { data } = await sb.from("lab_call_events").select("event_type, content, meta").eq("call_id", callId).order("id");
  return data ?? [];
}
const retriggers = (evs) => evs.filter((e) => e.event_type === "skipped" && e.meta?.reason === "retrigger").length;
const undelivered = (evs) => evs.filter((e) => e.event_type === "error" && e.meta?.reason === "undelivered").length;
const notes = () => controlMsgs.filter((m) => m.type === "add-message");
const triggering = () => notes().filter((m) => m.triggerResponseEnabled === true);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  — " + detail}`);
  ok ? pass++ : fail++;
};

// ── temp data ─────────────────────────────────────────────────
const created = { handlers: [], scripts: [], collections: [], calls: [] };
async function handler(row) {
  const { data, error } = await sb.from("listener_handlers").insert({ enabled: true, tags: ["tmp-verify"], mode: "both", priority: 50, ...row }).select().single();
  if (error) throw new Error("handler: " + error.message);
  created.handlers.push(data.id);
  return data;
}
async function script(name, build) {
  const { data: s, error } = await sb.from("listener_scripts").insert({ name, description: "tmp verify" }).select().single();
  if (error) throw new Error("script: " + error.message);
  created.scripts.push(s.id);
  const conn = (intentKey, any = false) => ({ id: "c:" + randomUUID(), intentKey: any ? "" : intentKey, label: "tmp", ...(any ? { any: true } : {}) });
  const node = (type, label, config, scenarioId, x, y) => ({ id: randomUUID(), script_id: s.id, type, label, config, scenario_id: scenarioId ?? null, pos_x: x, pos_y: y });
  const edge = (from, connector, to) => ({ id: randomUUID(), script_id: s.id, source_node_id: from.id, target_node_id: to.id, label: "", condition: connector.any ? { kind: "any", handle: connector.id } : { kind: "intent", by: "intent", value: connector.intentKey, handle: connector.id } });
  const { nodes, edges } = build({ conn, node, edge });
  let r = await sb.from("listener_script_nodes").insert(nodes);
  if (r.error) throw new Error("nodes: " + r.error.message);
  r = await sb.from("listener_script_edges").insert(edges);
  if (r.error) throw new Error("edges: " + r.error.message);
  return s.id;
}
async function activate(scriptId) {
  const { error } = await sb.from("lab_settings").update({ active_script_id: scriptId, trigger_response: true, injection_cooldown_ms: 0, confidence_threshold: 0.1 }).eq("id", "default");
  if (error) throw new Error("settings: " + error.message);
}
const newCall = () => { const id = "verify-brief-" + randomUUID(); created.calls.push(id); return id; };

// ── main ──────────────────────────────────────────────────────
const { data: settingsBackup } = await sb.from("lab_settings").select("*").eq("id", "default").single();
try {
  const hYes = await handler({ name: "tmp yes matcher", intent_key: "tmp_yes_reply", description: "customer agrees", response_template: "", action_type: "ignore", delivery: "verbatim", mode: "listener" });
  const hM1 = await handler({ name: "tmp member one", intent_key: "tmp_m1", description: "customer asks about the purple bonus", response_template: "The purple bonus covers your first two deposits.", action_type: "answer", delivery: "reword" });
  const hM2 = await handler({ name: "tmp member two", intent_key: "tmp_m2", description: "customer asks about timing", response_template: "It runs until Sunday midnight, no extensions.", action_type: "answer", delivery: "verbatim" });
  const hElse = await handler({ name: "tmp else line", intent_key: "tmp_else_line", description: "SPEAK-ONLY else", response_template: "Quick version: your account has a bonus waiting this week.", action_type: "answer", delivery: "reword" });
  const hBye = await handler({ name: "tmp reworded goodbye", intent_key: "tmp_bye_line", description: "SPEAK-ONLY goodbye", response_template: "Thank them warmly and say goodbye.", action_type: "answer", delivery: "reword" });
  await handler({ name: "tmp side answer", intent_key: "tmp_side", description: "an off-script playbook answer", response_template: "This is the playbook answering out of turn.", action_type: "answer", delivery: "reword" });

  const { data: colA, error: e1 } = await sb.from("listener_collections").insert({ name: "tmp-brief-A", description: "tmp verify" }).select().single();
  if (e1) throw new Error(e1.message);
  created.collections.push(colA.id);
  const { data: colB, error: e2 } = await sb.from("listener_collections").insert({ name: "tmp-brief-B", description: "tmp verify" }).select().single();
  if (e2) throw new Error(e2.message);
  created.collections.push(colB.id);
  await sb.from("listener_collection_handlers").insert([
    { collection_id: colB.id, handler_id: hM1.id },
    { collection_id: colB.id, handler_id: hM2.id },
  ]);

  const scriptE = await script("tmp-brief-E", ({ conn, node, edge }) => {
    const a1 = conn(null, true), a2 = conn(null, true), a3 = conn(null, true);
    const start = node("start", "Start call", { mode: "agent_first", opening: "", openingDelivery: "verbatim", connectors: [a1] }, null, 0, 0);
    const A = node("step", "Stage A", { contentType: "collection", collectionId: colA.id, connectors: [a2] }, null, 0, 200);
    const B = node("step", "Stage B", { contentType: "collection", collectionId: colB.id, statements: ["Everything is visible in the account anytime."], connectors: [a3] }, hElse.id, 0, 400);
    const end = node("step", "End call", { contentType: "end" }, null, 0, 600);
    return { nodes: [start, A, B, end], edges: [edge(start, a1, A), edge(A, a2, B), edge(B, a3, end)] };
  });
  const scriptD = await script("tmp-brief-D", ({ conn, node, edge }) => {
    const a1 = conn(null, true);
    const start = node("start", "Start call", { mode: "agent_first", opening: "", openingDelivery: "verbatim", connectors: [a1] }, null, 0, 0);
    const end = node("step", "End call", { contentType: "end" }, hBye.id, 0, 200);
    return { nodes: [start, end], edges: [edge(start, a1, end)] };
  });
  const scriptF = await script("tmp-brief-F", ({ conn, node, edge }) => {
    const cYes = conn("tmp_yes_reply");
    const start = node("start", "Start call", { mode: "agent_first", opening: "", openingDelivery: "verbatim", connectors: [cYes] }, null, 0, 0);
    const end = node("step", "End call", { contentType: "end" }, null, 0, 200);
    return { nodes: [start, end], edges: [edge(start, cYes, end)] };
  });

  // ── B1+B2: routed turn → no spoken line, one non-triggering stage briefing ──
  await activate(scriptE);
  const callE = newCall();
  {
    controlMsgs = [];
    await say(callE, "affirmative dolphin");
    await sleep(1800);
    check("B1 no say injection on a routed turn", !controlMsgs.some((m) => m.type === "say"), JSON.stringify(controlMsgs.map((m) => m.type)));
    check("B1 no TRIGGERING note ever", triggering().length === 0, JSON.stringify(triggering()));
    const briefs = notes();
    check("B1 exactly one stage briefing", briefs.length === 1, JSON.stringify(briefs.map((m) => (m.message?.content ?? "").slice(0, 60))));
    const content = briefs[0]?.message?.content ?? "";
    check("B2 briefing headed CURRENT STAGE with box label", /\[CURRENT STAGE — "Stage A"\]/.test(content), content.slice(0, 120));
    check("B2 members rendered with their rules", /purple bonus/.test(content) && /first two deposits/.test(content), content);
    check("B2 verbatim member marked word-for-word", /EXACTLY, word for word: "It runs until Sunday midnight/.test(content), content);
    check("B2 else line present", /If NOTHING above fits/.test(content) && /bonus waiting this week/.test(content), content);
    check("B2 statement rider present", /ALWAYS continue in the SAME reply/.test(content) && /visible in the account anytime/.test(content), content);
    check("G3 universal fallback path present", /fits NONE of the paths/.test(content) && /STANDING ANSWERS/.test(content), content);
    const evs = await events(callE);
    check("B1 model_side audit row logged", evs.some((e) => e.event_type === "injected" && e.meta?.mode === "model_side"), JSON.stringify(evs.map((e) => [e.event_type, e.meta?.mode])));
    check("B1 armed-stage row logged", evs.some((e) => e.event_type === "injected" && e.meta?.mode === "briefed" && /armed stage/.test(e.content ?? "")));
  }

  // ── B4: watchdog never retriggers model-side turns (pure silence) ──
  {
    await sleep(4000); // model_side + briefed rows now >3.5s old, no agent speech at all
    await watch(callE);
    await sleep(1500);
    const evs = await events(callE);
    check("B4 no retrigger on model-side turn", retriggers(evs) === 0, JSON.stringify(evs.map((e) => [e.event_type, e.meta?.reason])));
    check("B4 no undelivered error", undelivered(evs) === 0);
  }

  // ── G1: short unmapped turns are backchannel — never advance ──
  {
    const before = (await events(callE)).filter((e) => e.event_type === "injected").length;
    await say(callE, "Hello.");
    await sleep(1500);
    const evs = await events(callE);
    check("G1 backchannel held (skip logged)", evs.some((e) => e.event_type === "skipped" && e.meta?.reason === "backchannel"), JSON.stringify(evs.map((e) => [e.event_type, e.meta?.reason])));
    check("G1 backchannel did not advance the flow", evs.filter((e) => e.event_type === "injected").length === before);
  }

  // ── B3: a REAL unmapped reply advances via the catch-all and arms the following stage ──
  {
    controlMsgs = [];
    await say(callE, "well honestly I am not entirely sure what to make of all this");
    await sleep(1800);
    const briefs = notes();
    check("B3 second stage armed", briefs.length === 1 && /\[CURRENT STAGE — "Stage B"\]/.test(briefs[0]?.message?.content ?? ""), JSON.stringify(briefs.map((m) => (m.message?.content ?? "").slice(0, 80))));
    check("B3 goodbye path described as system-spoken", /system itself speaks the goodbye/.test(briefs[0]?.message?.content ?? ""));
    const evs = await events(callE);
    const modelSide = evs.filter((e) => e.event_type === "injected" && e.meta?.mode === "model_side");
    check("B3 else-line audit row uses the else scenario", modelSide.some((e) => /bonus waiting this week/.test(e.content ?? "")), JSON.stringify(modelSide.map((e) => e.content?.slice(0, 60))));
  }

  // ── B5: exact goodbye stays engine-spoken ──
  {
    controlMsgs = [];
    await say(callE, "alright I think we are all done here so goodbye now");
    await sleep(1800);
    const sayMsg = controlMsgs.find((m) => m.type === "say");
    check("B5 exact goodbye said by the engine", !!sayMsg && /Thanks for your time today/.test(sayMsg.content ?? ""), JSON.stringify(controlMsgs.map((m) => m.type)));
    check("B5 hangup attached to the goodbye", sayMsg?.endCallAfterSpoken === true);
  }

  // ── B6: reworded goodbye is model-side; watchdog hangs up after voicing ──
  await activate(scriptD);
  {
    const c = newCall();
    controlMsgs = [];
    await say(c, "affirmative dolphin");
    await sleep(1800);
    check("B6 no say and no note for reworded goodbye", !controlMsgs.some((m) => m.type === "say") && notes().length === 0, JSON.stringify(controlMsgs.map((m) => m.type)));
    await say(c, "Thanks so much for chatting today, goodbye now.", "assistant");
    await sleep(5000);
    await watch(c);
    await sleep(1500);
    check("B6 hangup after goodbye voiced", controlMsgs.some((m) => m.type === "end-call"), JSON.stringify(controlMsgs.map((m) => m.type)));
  }

  // ── W1-W4: Wait box — listens, then the silence path fires after waitSeconds ──
  {
    const hLine = await handler({ name: "tmp silence line", intent_key: "tmp_silence_line", description: "SPEAK-ONLY silence re-engage", response_template: "Just checking you're still with me — the offer is still on the table.", action_type: "answer", delivery: "reword" });
    const scriptW = await script("tmp-brief-W", ({ conn, node, edge }) => {
      const a1 = conn(null, true);
      const silence = { id: "c:" + randomUUID(), intentKey: "", silence: true, label: "customer stays silent" };
      const cYes = conn("tmp_yes_reply");
      const start = node("start", "Start call", { mode: "agent_first", opening: "", openingDelivery: "verbatim", connectors: [a1] }, null, 0, 0);
      const wait = node("step", "Hold and listen", { contentType: "wait", waitSeconds: 5, connectors: [cYes, silence] }, null, 0, 200);
      const reengage = node("step", "Re-engage", { contentType: "scenario", connectors: [] }, hLine.id, 0, 400);
      const end = node("step", "End call", { contentType: "end" }, null, 300, 400);
      const silenceEdge = { id: randomUUID(), script_id: wait.script_id, source_node_id: wait.id, target_node_id: reengage.id, label: "", condition: { kind: "timeout", handle: silence.id } };
      return { nodes: [start, wait, reengage, end], edges: [edge(start, a1, wait), edge(wait, cYes, end), silenceEdge] };
    });
    await activate(scriptW);
    const c = newCall();
    controlMsgs = [];
    await say(c, "well alright then let us wait and see what comes of this"); // any → Wait box
    await sleep(1800);
    const armed = notes().map((m) => m.message?.content ?? "");
    check("W1 wait menu excludes the silence path", armed.length === 1 && !/silent/i.test(armed[0]), JSON.stringify(armed.map((s) => s.slice(0, 80))));
    // A customer reply resets the silence clock — tick early, nothing fires.
    await watch(c);
    await sleep(1200);
    let evs = await events(c);
    check("W2 no premature silence advance", !evs.some((e) => e.meta?.mode === "silence_timeout"), JSON.stringify(evs.map((e) => [e.event_type, e.meta?.mode])));
    // Now 5s of total quiet → the poll tick advances down the silence path.
    controlMsgs = [];
    await sleep(4500);
    await watch(c);
    await sleep(1800);
    evs = await events(c);
    check("W3 silence advance fired once", evs.filter((e) => e.meta?.mode === "silence_timeout").length === 1, JSON.stringify(evs.map((e) => [e.event_type, e.meta?.mode])));
    const trig = controlMsgs.find((m) => m.type === "add-message" && m.triggerResponseEnabled === true);
    check("W3 re-engage line delivered with a trigger", !!trig && /offer is still on the table/.test(trig.message?.content ?? ""), JSON.stringify(controlMsgs.map((m) => m.type)));
    check("W3 flow moved to the silence target", evs.some((e) => e.meta?.mode === "silence_timeout" && e.meta?.nodeType === "scenario"));
    // Idempotent: another tick right after must not fire again.
    await watch(c);
    await sleep(1200);
    evs = await events(c);
    check("W4 no double-fire on the next tick", evs.filter((e) => e.meta?.mode === "silence_timeout").length === 1);
  }

  // ── O1-O3: observer pass — covered lines get marked, skipped statements come back as debts ──
  {
    const scriptO = await script("tmp-brief-O", ({ conn, node, edge }) => {
      const a1 = conn(null, true), a2 = conn(null, true), a3 = conn(null, true), a4 = conn(null, true);
      const start = node("start", "Start call", { mode: "agent_first", opening: "", openingDelivery: "verbatim", connectors: [a1] }, null, 0, 0);
      const A = node("step", "Stage A", { contentType: "collection", collectionId: colA.id, statements: ["Mention the moonlight discount before anything else happens tonight."], connectors: [a2] }, null, 0, 200);
      const B = node("step", "Stage B", { contentType: "collection", collectionId: colB.id, connectors: [a3] }, null, 0, 400);
      const C = node("step", "Stage C", { contentType: "collection", collectionId: colB.id, connectors: [a4] }, null, 0, 600);
      const end = node("step", "End call", { contentType: "end" }, null, 0, 800);
      return { nodes: [start, A, B, C, end], edges: [edge(start, a1, A), edge(A, a2, B), edge(B, a3, C), edge(C, a4, end)] };
    });
    await activate(scriptO);
    const c = newCall();
    controlMsgs = [];
    await say(c, "affirmative dolphin"); // → Stage A armed; no history yet
    await sleep(1800);
    let armed = notes().map((m) => m.message?.content ?? "").find((s) => /CURRENT STAGE/.test(s)) ?? "";
    check("O1 fresh call: purple-bonus line unmarked", /purple bonus/.test(armed) && !/ALREADY COVERED/.test(armed), armed.slice(0, 200));
    // The agent voices the purple-bonus member line, but NOT Stage A's statement.
    await say(c, "Right — so the purple bonus covers your first two deposits, by the way.", "assistant");
    controlMsgs = [];
    await say(c, "well honestly that is interesting tell me more about it then");
    await sleep(1800);
    armed = notes().map((m) => m.message?.content ?? "").find((s) => /CURRENT STAGE/.test(s)) ?? "";
    check("O2 covered line marked, not removed", /purple bonus/.test(armed) && /ALREADY COVERED/.test(armed), armed);
    check("O2 unsaid member NOT marked", !/Sunday midnight[^]*?ALREADY COVERED/.test(armed.split("It runs until")[1]?.slice(0, 200) ?? ""), armed);
    check("O2 skipped statement comes back as debt", /Still OWED/.test(armed) && /moonlight discount/.test(armed), armed);
    const evs = await events(c);
    check("O2 observer counts on the armed row", evs.some((e) => /armed stage: Stage B \(observer: \d+ covered, 1 owed\)/.test(e.content ?? "")), JSON.stringify(evs.filter((e) => e.meta?.mode === "briefed").map((e) => e.content)));
    // The agent pays the debt — next arming must drop it.
    await say(c, "Oh and before anything else — the moonlight discount is happening tonight.", "assistant");
    controlMsgs = [];
    await say(c, "alright then what else would you like to tell me about all this");
    await sleep(1800);
    armed = notes().map((m) => m.message?.content ?? "").find((s) => /CURRENT STAGE/.test(s)) ?? "";
    check("O3 paid debt disappears", armed.length > 0 && !/Still OWED/.test(armed), armed.slice(-300));
  }

  // ── R1-R2: interruption arbiter — noise that cut the agent off sends it back to finish ──
  await activate(scriptE);
  {
    const c = newCall();
    controlMsgs = [];
    await post({ type: "speech-update", status: "started", role: "assistant" }, c);
    await sleep(300);
    await post({ type: "speech-update", status: "stopped", role: "assistant" }, c); // cut off mid-line
    await say(c, "not hearing me."); // channel noise, lands right after the stop
    await sleep(1800);
    let evs = await events(c);
    check("R1 noise held as backchannel", evs.some((e) => e.event_type === "skipped" && e.meta?.reason === "backchannel"), JSON.stringify(evs.map((e) => [e.event_type, e.meta?.reason])));
    check("R1 interruption ruled ignorable — resume logged", evs.some((e) => e.meta?.mode === "resume"), JSON.stringify(evs.map((e) => [e.event_type, e.meta?.mode])));
    const nudge = controlMsgs.find((m) => m.type === "add-message" && m.triggerResponseEnabled === true);
    check("R1 resume nudge sent with a trigger", !!nudge && /Resume and finish/.test(nudge.message?.content ?? ""), JSON.stringify(controlMsgs.map((m) => m.type)));
    // R2: same noise long after the agent stopped — no resume (nothing was cut off).
    controlMsgs = [];
    await sleep(4000);
    await say(c, "hello?");
    await sleep(1800);
    evs = await events(c);
    check("R2 late noise held without a resume", evs.filter((e) => e.meta?.mode === "resume").length === 1, JSON.stringify(evs.map((e) => [e.event_type, e.meta?.mode])));
    check("R2 no nudge sent", controlMsgs.length === 0, JSON.stringify(controlMsgs.map((m) => m.type)));
  }

  // ── B7: reactive playbook fully suppressed on scripted calls ──
  await activate(scriptF);
  {
    const c = newCall();
    controlMsgs = [];
    await say(c, "crimson falcon");
    await sleep(1800);
    check("B7 no injection of any kind", controlMsgs.length === 0, JSON.stringify(controlMsgs.map((m) => m.type)));
    const evs = await events(c);
    check("B7 no injected events", !evs.some((e) => e.event_type === "injected"), JSON.stringify(evs.map((e) => e.event_type)));
    check("G4 held-at-stage made visible", evs.some((e) => e.event_type === "skipped" && e.meta?.reason === "held_at_stage"), JSON.stringify(evs.map((e) => [e.event_type, e.meta?.reason])));
  }
} finally {
  try {
    if (created.calls.length) {
      await sb.from("lab_call_events").delete().in("call_id", created.calls);
      await sb.from("lab_call_flow_state").delete().in("call_id", created.calls);
    }
    if (created.scripts.length) {
      await sb.from("listener_script_edges").delete().in("script_id", created.scripts);
      await sb.from("listener_script_nodes").delete().in("script_id", created.scripts);
      await sb.from("listener_scripts").delete().in("id", created.scripts);
    }
    if (created.collections.length) {
      await sb.from("listener_collection_handlers").delete().in("collection_id", created.collections);
      await sb.from("listener_collections").delete().in("id", created.collections);
    }
    if (created.handlers.length) await sb.from("listener_handlers").delete().in("id", created.handlers);
    if (settingsBackup) {
      const { id, updated_at, ...rest } = settingsBackup;
      await sb.from("lab_settings").update(rest).eq("id", "default");
    }
    console.log("cleanup done");
  } catch (e) {
    console.log("CLEANUP FAILED:", e.message);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
