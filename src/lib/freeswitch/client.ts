/**
 * FreeSWITCH ESL (Event Socket Library) client wrapper.
 *
 * Connects to FreeSWITCH's Event Socket on FREESWITCH_HOST:FREESWITCH_ESL_PORT
 * (default 8021), authenticates with FREESWITCH_ESL_PASSWORD, and exposes a
 * Promise-based interface over modesl's callback API.
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §10
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

// Minimal shape we use from modesl — the package ships no types.
interface ModeslResponse {
  getBody(): string;
  getHeader(name: string): string;
}
interface ModeslConn {
  api(cmd: string, cb: (res: ModeslResponse) => void): void;
  bgapi(cmd: string, cb: (res: ModeslResponse) => void): void;
  disconnect(): void;
  on(event: string, cb: (err: Error) => void): void;
}

export async function getESLConnection(): Promise<ESLConnection> {
  if (!FS_HOST || !FS_ESL_PASSWORD) {
    throw new Error(
      "FreeSWITCH ESL not configured. Set FREESWITCH_HOST and FREESWITCH_ESL_PASSWORD in .env.local / Vercel env.",
    );
  }

  // modesl is CJS and ships no TS types; require inside the function so the
  // module is only loaded when a real connection is actually attempted (stub
  // mode in originate.ts short-circuits before reaching here).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const modesl = require("modesl") as {
    Connection: new (host: string, port: number, password: string, readyCb: () => void) => ModeslConn;
  };

  return new Promise<ESLConnection>((resolve, reject) => {
    const conn = new modesl.Connection(FS_HOST, FS_ESL_PORT, FS_ESL_PASSWORD, () => {
      resolve({
        api: (cmd) => new Promise<string>((r) => conn.api(cmd, (res) => r(res.getBody()))),
        bgapi: (cmd) => new Promise<string>((r) => conn.bgapi(cmd, (res) => r(res.getHeader("Job-UUID")))),
        disconnect: () => new Promise<void>((r) => { conn.disconnect(); r(); }),
      });
    });
    conn.on("error", reject);
  });
}
