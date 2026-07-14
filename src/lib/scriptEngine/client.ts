import { createClient } from "@supabase/supabase-js";

// Isomorphic anon Supabase client for the Script Engine (browser + server).
// Mirrors Voizo's app-wide src/lib/supabase.ts: env-driven and UNTYPED (the
// codebase does not carry a generated Database generic; typed query inference
// under @supabase/supabase-js v2.99 resolves hand-written schemas to `{}`).
// Row shapes are asserted at the lab-db.ts boundary via the aliases in
// ./database.types. This is intentionally the ANON client — the engine is
// anon-only by design (plan §5); never import the service-role client
// (src/lib/supabaseServer.ts) into scriptEngine/*.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, anonKey);
