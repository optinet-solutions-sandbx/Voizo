// Server-only Supabase client for the Script Engine (workstream E, VOZ-116).
//
// Was the isomorphic ANON client — the Builder UIs read Supabase straight
// from the browser, which forced the lab tables' RLS to allow-all (public
// anon key could read the whole playbook + call transcripts off REST).
// Now: the engine runs on the service-role client, and browsers go through
// the Basic-Auth-gated /api/lab/db RPC (see lab-db-client.ts). This makes a
// default-deny RLS migration on the lab tables safe to apply.
//
// UNTYPED like src/lib/supabase.ts (the codebase carries no generated
// Database generic; row shapes are asserted at the lab-db.ts boundary via
// ./database.types).
import { supabaseAdmin } from "@/lib/supabaseServer";

// Tripwire instead of the `server-only` package (not a dependency): any
// client-bundle import of the lab-db chain explodes immediately on page load
// in dev/preview rather than silently failing on a missing env var.
if (typeof window !== "undefined") {
  throw new Error(
    "scriptEngine/client is server-only — browser code must use lab-db-client (the /api/lab/db RPC)."
  );
}

export const supabase = supabaseAdmin;
