// scripts/seed-qa-prompts.mjs
//
// Seed the QA Prompt Testing library (listener_qa_prompts) with the starter
// prompts. Idempotent: matches by title — re-running updates content in place
// rather than creating duplicates.
//
// PREREQUISITE: apply supabase-migration-qa-prompts.sql first (creates the table).
// Reads Supabase creds from .env.local. Run:  node scripts/seed-qa-prompts.mjs
//
// Prompt bodies live as plain .txt beside this script (scripts/seed-prompts/*.txt)
// so the large classification guidelines need no JSON/SQL escaping.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Minimal .env.local loader (KEY=VALUE, ignores comments/quotes).
const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// One entry per starter prompt. Add more .txt files + rows here as needed.
const SEED = [
  { file: "seed-prompts/val-prompt-official.txt", title: "VAL PROMP (OFFICIAL)", isActive: true },
];

async function main() {
  for (const s of SEED) {
    let content;
    try {
      content = readFileSync(join(__dirname, s.file), "utf8");
    } catch {
      console.error(`! skipping "${s.title}" — file not found: scripts/${s.file}`);
      continue;
    }

    const { data: existing, error: selErr } = await sb
      .from("listener_qa_prompts")
      .select("id")
      .eq("title", s.title)
      .maybeSingle();
    if (selErr) {
      console.error(`! lookup failed for "${s.title}":`, selErr.message);
      continue;
    }

    if (s.isActive) {
      await sb.from("listener_qa_prompts").update({ is_active: false }).eq("is_active", true);
    }

    if (existing) {
      const { error } = await sb
        .from("listener_qa_prompts")
        .update({ content, is_active: !!s.isActive })
        .eq("id", existing.id);
      if (error) console.error(`! update failed for "${s.title}":`, error.message);
      else console.log(`updated "${s.title}" (${content.length} chars)`);
    } else {
      const { error } = await sb
        .from("listener_qa_prompts")
        .insert({ title: s.title, content, is_active: !!s.isActive });
      if (error) console.error(`! insert failed for "${s.title}":`, error.message);
      else console.log(`inserted "${s.title}" (${content.length} chars)`);
    }
  }
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
