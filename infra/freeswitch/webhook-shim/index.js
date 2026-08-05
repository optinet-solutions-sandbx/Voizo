/**
 * FreeSWITCH → Voizo Webhook Shim
 *
 * Runs on the AWS EC2 instance alongside FreeSWITCH. Listens for FS events
 * via ESL and relays them to the Voizo dashboard as HTTP POSTs with HMAC-SHA256
 * signatures.
 *
 * Why this exists: FreeSWITCH doesn't speak HTTP webhooks natively. It emits
 * events over the Event Socket Layer (ESL) on port 8021. This shim is the
 * translation layer.
 *
 * Design principles (mirroring Voizo manifesto §6):
 *   - Idempotent-friendly: each event includes the voizo_call_id channel var
 *     so duplicate events hitting the dashboard twice don't corrupt state
 *   - HMAC signed: every POST includes x-freeswitch-signature header
 *   - Retry on HTTP failure: simple exponential backoff, max 3 attempts
 *   - Stateless: crashes are recoverable because all state lives in Voizo's DB
 *
 * STATUS: Phase 0 (2026-04-15) — skeleton. Not yet deployed. Runs when AWS box
 * is live (Phase 1+) alongside FreeSWITCH.
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §10 (Phase 0)
 *
 * Run:
 *   cd /opt/voizo-shim && node index.js
 * Or via systemd — see systemd.service example in this folder.
 */

"use strict";

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ── Config (from environment) ────────────────────────────────────────────────
const ESL_HOST = process.env.ESL_HOST || "127.0.0.1";
const ESL_PORT = parseInt(process.env.ESL_PORT || "8021", 10);
const ESL_PASSWORD = process.env.ESL_PASSWORD;
const VOIZO_WEBHOOK_URL = process.env.VOIZO_WEBHOOK_URL;
const VOIZO_WEBHOOK_SECRET = process.env.VOIZO_WEBHOOK_SECRET;
const DRY_RUN = process.env.DRY_RUN === "true"; // log-only mode for testing

// Retry config
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// ── Validate config at startup (manifesto: loud failure, not silent undefined) ──
function validateEnv() {
  const missing = [];
  if (!ESL_PASSWORD) missing.push("ESL_PASSWORD");
  if (!VOIZO_WEBHOOK_URL) missing.push("VOIZO_WEBHOOK_URL");
  if (!VOIZO_WEBHOOK_SECRET) missing.push("VOIZO_WEBHOOK_SECRET");
  if (missing.length > 0) {
    console.error(
      `FATAL: missing required env vars: ${missing.join(", ")}\n` +
      `See infra/freeswitch/webhook-shim/README.md for setup.`,
    );
    process.exit(1);
  }
}

// ── HMAC signing ──────────────────────────────────────────────────────────────
function signBody(rawBody) {
  return crypto
    .createHmac("sha256", VOIZO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
}

// ── HTTP POST to Voizo with retries ──────────────────────────────────────────
function postToVoizo(payload, attempt = 1) {
  return new Promise((resolve) => {
    const url = new URL(VOIZO_WEBHOOK_URL);
    const rawBody = JSON.stringify(payload);
    const signature = signBody(rawBody);

    const lib = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(rawBody),
        "x-freeswitch-signature": signature,
        "user-agent": "voizo-freeswitch-shim/0.1",
      },
    };

    if (DRY_RUN) {
      console.log(`[DRY_RUN] would POST ${VOIZO_WEBHOOK_URL}: ${rawBody}`);
      return resolve(true);
    }

    const req = lib.request(options, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(
            `[shim] POST ${VOIZO_WEBHOOK_URL} → ${res.statusCode} (call=${payload.voizo_call_id})`,
          );
          return resolve(true);
        }
        console.warn(
          `[shim] POST failed: ${res.statusCode} body=${chunks.slice(0, 200)} attempt=${attempt}`,
        );
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
          setTimeout(() => postToVoizo(payload, attempt + 1).then(resolve), delay);
        } else {
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.warn(`[shim] POST error: ${err.message} attempt=${attempt}`);
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        setTimeout(() => postToVoizo(payload, attempt + 1).then(resolve), delay);
      } else {
        resolve(false);
      }
    });

    req.write(rawBody);
    req.end();
  });
}

// ── Translate an ESL event into Voizo's webhook payload shape ───────────────
function translateEvent(event) {
  // modesl's Event object has .getHeader(name) which returns channel variables
  // and standard event headers. Channel vars are prefixed "variable_" in the
  // raw ESL protocol, but modesl strips that — sometimes. To be safe we check
  // both with and without prefix.
  const get = (name) => event.getHeader(name) || event.getHeader(`variable_${name}`) || null;

  return {
    voizo_call_id: get("voizo_call_id"),
    voizo_campaign_id: get("voizo_campaign_id"),
    voizo_number_id: get("voizo_number_id"),
    call_uuid: get("Unique-ID") || get("uuid"),
    event_name: event.getHeader("Event-Name"),
    hangup_cause: get("Hangup-Cause") || get("hangup_cause"),
    // TOTAL channel seconds, INCLUDING ring. Kept for backward compatibility so
    // an un-redeployed Voizo build keeps behaving exactly as before — but it is
    // NOT evidence of a conversation. See talk_seconds below.
    duration: get("variable_duration") || get("duration") || get("billsec"),
    // VOZ-247. `duration` includes ringing, so Voizo was logging a phone that
    // rang 25s and was never answered as a 25-second COMPLETED call (450 such
    // rows in the 2026-07-27/28 run; reported answer rate 92% vs a real 29.5%).
    // billsec is answer->hangup only, and is "0" when nobody picked up.
    talk_seconds: get("billsec"),
    // answer_stamp exists ONLY on an answered channel, so it settles the
    // question even when a pickup-and-drop rounds billsec down to 0.
    answer_stamp: get("answer_stamp"),
    // 2026-08-05: the carrier's actual SIP reply. During the 15s-intercept
    // investigation the ONLY record of WHY a call died was our own coarse
    // hangup_cause — the SIP final response code was recorded nowhere. These
    // three settle "who ended it and with what code" per call. The Vercel
    // route ignores unknown fields, so this deploys independently.
    sip_term_status: get("sip_term_status"),
    sip_hangup_disposition: get("sip_hangup_disposition"),
    proto_specific_hangup_cause: get("proto_specific_hangup_cause"),
    timestamp: event.getHeader("Event-Date-Timestamp"),
  };
}

// ── Main: connect to ESL and subscribe ───────────────────────────────────────
function start() {
  validateEnv();

  // Lazy-require modesl so the shim can be syntax-checked without the dep installed.
  // The real install happens on the AWS box: `npm install modesl` at deploy time.
  let modesl;
  try {
    modesl = require("modesl");
  } catch {
    console.error(
      "FATAL: 'modesl' not installed. Run `npm install modesl` in this folder first.",
    );
    process.exit(1);
  }

  console.log(`[shim] connecting to FreeSWITCH ESL at ${ESL_HOST}:${ESL_PORT}`);

  const conn = new modesl.Connection(ESL_HOST, ESL_PORT, ESL_PASSWORD, () => {
    console.log("[shim] ESL connected. Subscribing to CHANNEL_HANGUP_COMPLETE");
    conn.events("plain", "CHANNEL_HANGUP_COMPLETE");

    conn.on("esl::event::CHANNEL_HANGUP_COMPLETE::*", (event) => {
      const payload = translateEvent(event);

      // Only forward events that have a voizo_call_id — these are calls we
      // originated. Ignores any other channels on the box (manual test calls,
      // etc.) so we don't spam the dashboard.
      if (!payload.voizo_call_id) {
        return;
      }

      // total vs talk is the whole point of VOZ-247 — log both so an operator can
      // see at a glance that a 25s/0s line is a ring, not a conversation. This is
      // also the deploy check: `journalctl -u voizo-webhook-shim` must show
      // talk= and answered= after a redeploy.
      console.log(
        `[shim] event received — call=${payload.voizo_call_id} ` +
        `cause=${payload.hangup_cause} total=${payload.duration}s talk=${payload.talk_seconds}s ` +
        `answered=${payload.answer_stamp ? "yes" : "no"} ` +
        `sip=${payload.sip_term_status || "-"} by=${payload.sip_hangup_disposition || "-"} ` +
        `proto=${payload.proto_specific_hangup_cause || "-"}`,
      );
      postToVoizo(payload);
    });
  });

  conn.on("error", (err) => {
    console.error(`[shim] ESL error: ${err.message || err}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[shim] shutting down");
    try {
      conn.disconnect();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
