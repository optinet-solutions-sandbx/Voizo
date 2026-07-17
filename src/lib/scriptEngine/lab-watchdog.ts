// Server-only: the delivery watchdog, shared by every invocation that gets
// CPU during a call. Serverless freezes background timers (live calls proved
// after()+setTimeout never runs on Vercel), so the check is invoked from
// wherever a live request exists: webhook messages (assistant speech-updates,
// status updates) and the Script Builder's 1.2s run poll via /api/lab/watch —
// during TOTAL silence the webhook goes quiet too, and the poll is the only
// reliable clock. Idempotent across concurrent invocations via persisted
// retrigger/error marker events.
import {
  insertLabEvent,
  lastFlowInjection,
  hasNewerUtterance,
  agentSaidAfter,
  assistantSpeaking,
  watchdogStateAfter,
  getLabSettings,
  getFlowState,
  getScriptGraph,
  persistFlowStateGuarded,
  listHandlers,
  lastSpeechAt,
} from "./lab-db";
import { getControlUrl, injectStaffNote, injectSay, endCall } from "./lab-control";
import { contentTypeOf } from "./lab-flow";
import { composeArmedBriefing } from "./lab-briefing";
import { resolveCallScriptId } from "./resolveScript";
import { substituteVars } from "./substituteVars";

// The idle nudges configure-assistant installs — spoken by VAPI itself, so
// they must never count as the briefed line having been delivered.
const IDLE_NUDGES = ["Take your time — I'm still here.", "Are you still with me?", "Can you hear me okay?"];

/** Wait-box silence timeout, driven by the same poll clock. When the flow
 *  parks on a Wait box that has a silence path ({kind:"timeout"} edge) and
 *  NOBODY has spoken for the box's waitSeconds (idle nudges excluded), the
 *  call advances down that path: the target's line is engine-delivered —
 *  silence means there is no customer turn to make the model answer
 *  natively — and the target's own stage menu is armed. The flow-state
 *  optimistic lock makes concurrent poll ticks single-fire. */
export async function checkWaitTimeout(callId: string, controlUrlHint: string | null): Promise<void> {
  try {
    // Workstream C: gate on THIS call's script (seeded campaign calls keep
    // their silence timeouts even when the global Active toggle is null/other).
    const [settings, state] = await Promise.all([
      getLabSettings().catch(() => null),
      getFlowState(callId).catch(() => null),
    ]);
    if (!state?.current_node_id) return;
    const scriptId = resolveCallScriptId(state, settings);
    if (!scriptId) return;
    const graph = await getScriptGraph(scriptId);
    const node = graph.nodes.find((n) => n.id === state.current_node_id);
    if (!node || contentTypeOf(node) !== "wait") return;
    const timeoutEdge = graph.edges.find(
      (e) => e.source_node_id === node.id && ((e.condition ?? {}) as Record<string, unknown>).kind === "timeout"
    );
    if (!timeoutEdge) return;
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    const waitMs = Math.min(120, Math.max(2, Number(cfg.waitSeconds) || 8)) * 1000;
    // The silence clock starts at whichever is newest: entering the box or
    // the last real speech from either side.
    const entered = new Date(state.updated_at as string).getTime();
    const spoke = await lastSpeechAt(callId, IDLE_NUDGES).catch(() => null);
    if (Date.now() - Math.max(entered, spoke ?? 0) < waitMs) return;
    if (await assistantSpeaking(callId)) return;
    const target = graph.nodes.find((n) => n.id === timeoutEdge.target_node_id);
    if (!target) return;
    // Advance under the lock BEFORE speaking — a lost race means another
    // invocation (a real turn or another tick) already moved the call.
    const won = await persistFlowStateGuarded(
      callId,
      scriptId,
      target.id,
      (state.variables as Record<string, unknown>) ?? {},
      state.updated_at as string
    );
    if (!won) return;
    const handlers = await listHandlers().catch(() => []);
    const byId = new Map(handlers.map((h) => [h.id, h] as const));
    const ct = contentTypeOf(target);
    const tCfg = (target.config ?? {}) as Record<string, unknown>;
    const statements = (((tCfg.statements as string[]) ?? []).map((s) => (s ?? "").trim()).filter(Boolean));
    const scn = target.scenario_id ? byId.get(target.scenario_id) : undefined;
    // Greet-by-name Ramp 2: render {{playerName}} etc. from the call's variables.
    const callVars = (state.variables as Record<string, unknown>) ?? null;
    const text = substituteVars(
      [scn?.response_template?.trim() || (ct === "end" ? "Thanks for your time today. Goodbye!" : ""), ...statements]
        .filter(Boolean)
        .join(" "),
      callVars,
    );
    // The poll route runs as a separate lambda with no in-memory control-url
    // cache — fall back to the url stamped on the call's last injection row.
    const lastInj = await lastFlowInjection(callId).catch(() => null);
    const hint = controlUrlHint ?? ((lastInj?.meta.controlUrl as string | undefined) || null);
    const controlUrl = await getControlUrl(callId, hint);
    if (ct === "end") {
      await insertLabEvent({
        call_id: callId,
        event_type: "injected",
        content: text,
        handler_id: scn?.id ?? null,
        action_type: "flow:end",
        meta: { flow: true, toNode: target.id, nodeType: "end", mode: "silence_timeout", ...(controlUrlHint ? { controlUrl: controlUrlHint } : {}) },
      }).catch(() => {});
      if (controlUrl) {
        const r = await injectSay(controlUrl, text, true).catch(() => ({ ok: false }));
        if (!r.ok) await endCall(controlUrl).catch(() => {});
      }
      return;
    }
    // Arm the target's menu FIRST (through the observer pass), then deliver
    // its line with a trigger — logged last so the delivery watchdog above
    // guards exactly this row.
    if (controlUrl) {
      const armed = await composeArmedBriefing(callId, graph, target.id, handlers).catch(() => null);
      if (armed) {
        await injectStaffNote(controlUrl, substituteVars(armed.text, callVars), false).catch(() => {});
        await insertLabEvent({
          call_id: callId,
          event_type: "injected",
          content: `→ armed stage: ${target.label || ct}${armed.covered || armed.owed ? ` (observer: ${armed.covered} covered, ${armed.owed} owed)` : ""}`,
          meta: { flow: true, mode: "briefed", toNode: target.id, nodeType: ct, covered: armed.covered, owed: armed.owed },
        }).catch(() => {});
      }
    }
    await insertLabEvent({
      call_id: callId,
      event_type: "injected",
      content: text || `→ ${target.label || ct}`,
      handler_id: scn?.id ?? null,
      action_type: `flow:${ct}`,
      meta: { flow: true, toNode: target.id, nodeType: ct, mode: "silence_timeout", ...(controlUrlHint ? { controlUrl: controlUrlHint } : {}) },
    }).catch(() => {});
    if (controlUrl && text) {
      if (scn?.delivery === "verbatim") {
        await injectSay(controlUrl, text, false).catch(() => {});
      } else {
        await injectStaffNote(
          controlUrl,
          `The customer has stayed quiet — re-engage NOW by delivering this step (own words, keep facts exact; if it reads as an instruction, do what it asks; never read instruction wording aloud): ${text}`,
          true
        ).catch(() => {});
      }
    }
  } catch {
    /* best effort */
  }
}

/** The model sometimes answers a triggered briefing with its filler ALONE
 *  ("Uh-huh." … silence) — it "waits" for a line that already arrived — or
 *  the trigger races the filler and gets swallowed. Verify substantial
 *  speech followed the newest injection; re-trigger once with blunter
 *  wording; if even that stays silent, log a red error so an undelivered
 *  line can never pass QA unnoticed. Also owns the reworded-goodbye hangup
 *  (its setTimeout has the same serverless-freeze bug). */
export async function checkDelivery(callId: string, controlUrlHint: string | null): Promise<void> {
  try {
    const inj = await lastFlowInjection(callId);
    if (!inj || !inj.content || !inj.meta.flow) return;
    if (inj.meta.mode === "disabled_skipped") return;
    const nodeType = inj.meta.nodeType as string | undefined;
    const age = Date.now() - new Date(inj.createdAt).getTime();
    // Prefer the caller's hint, else the control url stamped on the
    // injection row — the poll route has no in-memory cache to fall back on.
    const hint = controlUrlHint ?? ((inj.meta.controlUrl as string | undefined) || null);
    // Goodbyes end the call themselves — once the goodbye was voiced (or
    // waiting stopped making sense), hang up.
    if (nodeType === "end") {
      const voiced = await agentSaidAfter(callId, inj.id, 10, IDLE_NUDGES);
      const overdue = inj.meta.rewordGoodbye ? (voiced && age > 5000) || age > 15000 : !voiced && age > 8000;
      if (overdue && !(await assistantSpeaking(callId))) {
        const controlUrl = await getControlUrl(callId, hint);
        if (controlUrl) await endCall(controlUrl).catch(() => {});
      }
      return;
    }
    if (nodeType === "transfer") return;
    // Brief-ahead turns speak MODEL-SIDE — there is no supplied line to
    // deliver, so a "retrigger" here would force a duplicate reply on top of
    // the model's own. Resume nudges are best-effort continuations, not
    // deliverable lines. The watchdog only guards triggering injections.
    if (inj.meta.mode === "model_side" || inj.meta.mode === "briefed" || inj.meta.mode === "resume") return;
    // 3.5s, not 5: `age` compares a DB timestamp against this machine's
    // clock, and ~1s of skew once made a 5s check measure 4.4s and skip.
    // A normal delivery starts speaking well inside 3.5s, and the speech
    // guards above stand down for anything already in flight.
    if (age < 3500 || age > 60000) return;
    if (await hasNewerUtterance(callId, inj.id)) return; // customer moved on — the new turn owns delivery
    if (await agentSaidAfter(callId, inj.id, 20, IDLE_NUDGES)) return; // substantial non-idle speech = delivered
    if (await assistantSpeaking(callId)) return; // mid-speech — the next check re-verifies
    const wd = await watchdogStateAfter(callId, inj.id);
    if (wd.errored) return;
    if (wd.retriggerAt) {
      // Same skew tolerance as the age gate above.
      if (Date.now() - new Date(wd.retriggerAt).getTime() < 4000) return;
      await insertLabEvent({
        call_id: callId,
        event_type: "error",
        content: "line never voiced — briefing and retrigger both produced no speech",
        meta: { flow: true, reason: "undelivered" },
      }).catch(() => {});
      return;
    }
    const controlUrl = await getControlUrl(callId, hint);
    if (!controlUrl) return;
    // Marker first: it is the idempotency lock other invocations check.
    await insertLabEvent({
      call_id: callId,
      event_type: "skipped",
      content: "briefing produced no speech — re-triggering once",
      meta: { flow: true, reason: "retrigger" },
    }).catch(() => {});
    await injectStaffNote(
      controlUrl,
      `You paused after your filler, but the supplied step is still UNDELIVERED — speak it NOW, nothing else (if it's written as an instruction, say what it asks for; never read instruction wording aloud): ${inj.content}`,
      true
    );
  } catch {
    /* best effort */
  }
}
