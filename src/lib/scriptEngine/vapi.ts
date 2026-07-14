// Do NOT import @vapi-ai/web at the top level — it uses browser-only APIs
// (AudioContext, RTCPeerConnection, etc.) that crash during Next.js SSR.
// We lazy-load it at call time so it only runs in the browser (inside useEffect).

// Voizo's browser (public) VAPI key drives attended Script Builder test calls.
const VAPI_PUBLIC_API_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? "";
// Default test assistant for the run dock. TODO(VOZ-154): point this at a
// designated Voizo script-base test assistant (this id is from the source app).
export const VAPI_ASSISTANT_ID = "509156f5-78b7-4644-901a-acbc3415472d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vapiInstance: any | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getVapi(): any {
  if (!vapiInstance) {
    // require() defers the load to call-time (browser only, inside useEffect)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Vapi = require("@vapi-ai/web").default;
    vapiInstance = new Vapi(VAPI_PUBLIC_API_KEY);
  }
  return vapiInstance;
}

// VAPI SDK error events can be plain objects like {type, msg, details} —
// rendering one as a React child crashes the app, so always coerce to string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function vapiErrorText(err: any, fallback: string): string {
  const cand = err?.message ?? err?.error?.message ?? err?.errorMsg ?? err?.msg ?? err;
  if (typeof cand === "string" && cand) return cand;
  // e.g. err.message = {type:"ejected", msg:"Meeting has ended"} — drill one level
  const inner = cand?.msg ?? cand?.message ?? cand?.errorMsg;
  if (typeof inner === "string" && inner) return inner;
  try {
    const s = JSON.stringify(cand);
    return s && s !== "{}" ? s : fallback;
  } catch {
    return fallback;
  }
}

// When VAPI terminates a call server-side (silence timeout, end-call control,
// agent hangup), Daily ejects the browser participant and the SDK surfaces it
// as an "error" — it's actually a normal end of call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isBenignCallEnd(err: any): boolean {
  const text = vapiErrorText(err, "");
  return /meeting has ended|ejected/i.test(text);
}
