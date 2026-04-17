/**
 * FreeSWITCH ESL (Event Socket Library) client wrapper.
 *
 * STATUS: STUB (Phase 0, 2026-04-15) — returns a placeholder connection until the
 * AWS FreeSWITCH instance is provisioned and reachable. Real implementation will
 * use the `modesl` package or a thin wrapper over its TCP socket protocol.
 *
 * Once the AWS box is live, this module will:
 *   1. Connect to FREESWITCH_HOST:FREESWITCH_ESL_PORT (default 8021)
 *   2. Authenticate with FREESWITCH_ESL_PASSWORD
 *   3. Expose a Promise-based interface for `originate`, `bgapi`, and event subscriptions
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §10 (Phase 0 deliverables)
 */

const FS_HOST = process.env.FREESWITCH_HOST;
const FS_ESL_PORT = parseInt(process.env.FREESWITCH_ESL_PORT || "8021", 10);
const FS_ESL_PASSWORD = process.env.FREESWITCH_ESL_PASSWORD;

export interface ESLConnection {
  /** Send a synchronous API command. Returns FS response body. */
  api(command: string): Promise<string>;
  /** Send a background API command. Returns FS job UUID. */
  bgapi(command: string): Promise<string>;
  /** Close the connection gracefully. */
  disconnect(): Promise<void>;
}

/**
 * Get an ESL connection to FreeSWITCH.
 *
 * STUB: throws a descriptive error until the AWS box is live + the modesl package
 * is added to dependencies. Real implementation is straightforward — modesl handles
 * the TCP socket and command/response framing.
 */
export async function getESLConnection(): Promise<ESLConnection> {
  if (!FS_HOST || !FS_ESL_PASSWORD) {
    throw new Error(
      "FreeSWITCH ESL not configured. Set FREESWITCH_HOST and FREESWITCH_ESL_PASSWORD in .env.local. " +
      "Until the AWS PoC instance is provisioned (see docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §6 Phase 1), " +
      "this stub will throw. Phase 0 scaffolding only — not yet wired to a live FS instance.",
    );
  }

  // TODO (Phase 4 of the PoC spec): replace with real modesl connection.
  // Reference shape:
  //   const modesl = require("modesl");
  //   return new Promise((resolve, reject) => {
  //     const conn = new modesl.Connection(FS_HOST, FS_ESL_PORT, FS_ESL_PASSWORD, () => {
  //       resolve({
  //         api:        (cmd) => new Promise((r) => conn.api(cmd, (res) => r(res.getBody()))),
  //         bgapi:      (cmd) => new Promise((r) => conn.bgapi(cmd, (res) => r(res.getHeader("Job-UUID")))),
  //         disconnect: () => new Promise((r) => { conn.disconnect(); r(); }),
  //       });
  //     });
  //     conn.on("error", reject);
  //   });

  throw new Error(
    "FreeSWITCH ESL connection not yet implemented. Phase 0 stub. " +
    "Install `modesl` and implement the connection block above when AWS instance is reachable.",
  );
}
