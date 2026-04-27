"use strict";

/**
 * Voizo originate-shim — minimal HTTP receiver on the EC2 box that translates
 * Voizo dashboard originate requests into FreeSWITCH ESL bgapi commands.
 *
 * Why this exists: Vercel can't reach EC2 port 8021 (ESL) directly without
 * exposing FS's full command surface to the internet. This shim runs ON the
 * EC2 box, listens on a narrow HTTP port (default 7777), validates HMAC-signed
 * requests from Voizo, and issues ESL commands on 127.0.0.1.
 *
 * Companion to webhook-shim (which goes FS → Voizo for events). This goes
 * Voizo → FS for commands.
 *
 * Path: Voizo dashboard (Vercel) → POST /originate → this shim → ESL bgapi → FS
 */

const http = require("http");
const crypto = require("crypto");

// ── Config (from environment) ────────────────────────────────────────────────
const SHIM_PORT = parseInt(process.env.SHIM_PORT || "7777", 10);
const SHIM_SECRET = process.env.SHIM_SECRET;
const ESL_HOST = process.env.ESL_HOST || "127.0.0.1";
const ESL_PORT = parseInt(process.env.ESL_PORT || "8021", 10);
const ESL_PASSWORD = process.env.ESL_PASSWORD;

// ── Validate config at startup ──────────────────────────────────────────────
function validateEnv() {
  const missing = [];
  if (!SHIM_SECRET) missing.push("SHIM_SECRET");
  if (!ESL_PASSWORD) missing.push("ESL_PASSWORD");
  if (missing.length > 0) {
    console.error(`FATAL: missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ── Lazy-load modesl ─────────────────────────────────────────────────────────
let modesl;
try {
  modesl = require("modesl");
} catch {
  console.error(
    "FATAL: 'modesl' not installed. Run `npm install --production` in this folder first.",
  );
  process.exit(1);
}

// ── ESL bgapi via a fresh connection per request ────────────────────────────
function bgapi(command) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(val);
    };

    const conn = new modesl.Connection(ESL_HOST, ESL_PORT, ESL_PASSWORD, () => {
      conn.bgapi(command, (eslRes) => {
        const jobUuid = eslRes.getHeader("Job-UUID") || null;
        try { conn.disconnect(); } catch {}
        finish(null, { jobUuid });
      });
    });

    conn.on("error", (err) => {
      try { conn.disconnect(); } catch {}
      finish(err);
    });

    setTimeout(() => {
      try { conn.disconnect(); } catch {}
      finish(new Error("ESL connection timeout"));
    }, 30000);
  });
}

// ── HMAC verification (timing-safe) ──────────────────────────────────────────
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== "string") return false;
  const expected = crypto.createHmac("sha256", SHIM_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Originate handler ────────────────────────────────────────────────────────
async function handleOriginate(req, res, rawBody) {
  if (!verifySignature(rawBody, req.headers["x-shim-signature"])) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid signature" }));
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid json" }));
  }

  const { to, callerId, callId, vapiAssistantId, campaignId, numberId } = payload;

  if (!to || typeof to !== "string" || !to.startsWith("+")) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid 'to' (E.164 with leading +)" }));
  }
  if (!callerId || typeof callerId !== "string" || !callerId.startsWith("+")) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid 'callerId' (E.164 with leading +)" }));
  }
  if (!callId) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "missing 'callId'" }));
  }
  if (!vapiAssistantId || !/^[a-zA-Z0-9_-]+$/.test(vapiAssistantId)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid 'vapiAssistantId'" }));
  }

  const channelVars = [
    `origination_caller_id_number=${callerId}`,
    `voizo_call_id=${callId}`,
    `voizo_vapi_assistant=${vapiAssistantId}`,
    "ignore_early_media=true",
    campaignId ? `voizo_campaign_id=${campaignId}` : null,
    numberId ? `voizo_number_id=${numberId}` : null,
  ]
    .filter(Boolean)
    .join(",");

  const fsCommand = `originate {${channelVars}}sofia/gateway/squaretalk/${to} &transfer(voizo_bridge_to_vapi XML default)`;

  console.log(`[shim] originate request: callId=${callId} to=${to}`);

  try {
    const result = await bgapi(fsCommand);
    console.log(`[shim] originate result: callId=${callId} jobUuid=${result.jobUuid}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jobUuid: result.jobUuid }));
  } catch (err) {
    console.error(`[shim] ESL error: ${err.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────
function start() {
  validateEnv();

  const server = http.createServer((req, res) => {
    // Health check (unauthenticated, for monitoring + reachability tests)
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    }

    if (req.method !== "POST" || req.url !== "/originate") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }

    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 16384) {
        req.destroy();
      }
    });
    req.on("end", () => {
      handleOriginate(req, res, rawBody).catch((err) => {
        console.error(`[shim] handler error: ${err.message}`);
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } catch {}
      });
    });
  });

  server.listen(SHIM_PORT, () => {
    console.log(`[voizo-originate-shim] HTTP listening on :${SHIM_PORT}`);
    console.log(`[voizo-originate-shim] ESL target ${ESL_HOST}:${ESL_PORT}`);
  });

  const shutdown = () => {
    console.log("[shim] shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start();
