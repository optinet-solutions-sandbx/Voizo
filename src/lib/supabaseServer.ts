import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client — uses the service role key to bypass RLS.
// NEVER import this from client components.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error("FATAL: NEXT_PUBLIC_SUPABASE_URL is not set");
if (!key) throw new Error("FATAL: SUPABASE_SERVICE_ROLE_KEY is not set");

export const supabaseAdmin = createClient(url, key);
