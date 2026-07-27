// Add a Call Goal box to the LIVE Val scripts (VOZ-230).
//
// QA of the last 10 Val calls found the production Val script has NO fact:/must:
// tags and no Call Goal box, so the observer had nothing to track and the agent
// repeated freely. This adds a FLOATING Call Goal box (no edges — never routed
// through) whose statements are the offer the call must cover. With VOZ-208..212
// the observer then tracks each against the transcript and stops re-serving once
// said. Additive + idempotent: removes any prior call_goal node on the script
// first, then adds a fresh one. Never touches edges or other nodes.
//
// NOTE: script campaigns run a FROZEN copy of the script, so this affects
// NEW campaigns cloned from these originals — existing running copies keep the
// version they were launched with.
//
// RUN (repo root):  node scripts/seed-val-call-goal.mjs
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Detection-friendly phrasing (VOZ-229 strips authoring words + numbers, so the
// content words carry it): plain topic statements, one fact each, priority order.
const GOALS = [
  "The customer has twenty free spins waiting on their account.",
  "They can also claim a three hundred percent bonus on their next deposit.",
  "The free spins have an expiry date, so they shouldn't wait.",
  "You're sending an SMS with all the offer details.",
];

// The live originals the campaigns clone from.
const TARGET_NAMES = ["Lucky7even - Val - 20FS + 300% DB", "FortunePlay - Val - 20FS + 300% DB"];

for (const name of TARGET_NAMES) {
  const { data: scripts } = await sb.from("listener_scripts").select("id,name").eq("name", name);
  const s = (scripts ?? [])[0];
  if (!s) { console.log(`SKIP  "${name}" — not found`); continue; }

  // idempotent: drop any existing call_goal node(s) on this script
  const { data: nodes } = await sb.from("listener_script_nodes").select("id,config").eq("script_id", s.id);
  const existing = (nodes ?? []).filter((n) => (n.config ?? {}).contentType === "call_goal");
  for (const n of existing) await sb.from("listener_script_nodes").delete().eq("id", n.id);

  const { error } = await sb.from("listener_script_nodes").insert({
    id: randomUUID(),
    script_id: s.id,
    type: "step",
    label: "Call Goal",
    config: { contentType: "call_goal", statements: GOALS },
    scenario_id: null,
    pos_x: 760,
    pos_y: 40,
  });
  if (error) { console.log(`FAIL  "${name}": ${error.message}`); continue; }
  await sb.from("listener_scripts").update({ updated_at: new Date().toISOString() }).eq("id", s.id);
  console.log(`OK    "${name}" (${s.id.slice(0, 8)}) — Call Goal box added (${GOALS.length} goals, replaced ${existing.length} prior)`);
}
console.log("\nGoals:");
GOALS.forEach((g, i) => console.log(`  ${i + 1}. ${g}`));
