const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=== Diagnosing Campaign Duplication Database State ===");

  // ── Load Environment Variables ──
  const envPath = path.resolve(__dirname, "../.env.local");
  if (!fs.existsSync(envPath)) {
    console.error(`Error: .env.local file not found at ${envPath}`);
    process.exit(1);
  }

  const envContent = fs.readFileSync(envPath, "utf-8");
  const env = {};
  envContent.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const parts = trimmed.split("=");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let val = parts.slice(1).join("=").trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      env[key] = val;
    }
  });

  const supabaseUrl = env["NEXT_PUBLIC_SUPABASE_URL"];
  const supabaseKey = env["SUPABASE_SERVICE_ROLE_KEY"];

  if (!supabaseUrl || !supabaseKey) {
    console.error("Error: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env.local");
    process.exit(1);
  }

  // Load Supabase Client from node_modules
  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log("Connecting to Supabase...");

  // Fetch the 15 most recent campaigns
  const { data: campaigns, error } = await supabase
    .from("campaigns_v2")
    .select("id, name, status, campaign_type, created_at, vapi_pool_slot_id, vapi_assistant_id")
    .order("created_at", { ascending: false })
    .limit(15);

  if (error) {
    console.error("Failed to query campaigns:", error);
    process.exit(1);
  }

  console.log(`\nFound ${campaigns.length} recent campaigns in campaigns_v2:\n`);
  campaigns.forEach((c) => {
    console.log(`[${c.created_at}] ID: ${c.id}`);
    console.log(`  Name:   "${c.name}"`);
    console.log(`  Status: ${c.status}`);
    console.log(`  Type:   ${c.campaign_type}`);
    console.log(`  Slot:   ${c.vapi_pool_slot_id || "None"}`);
    console.log(`  Vapi ID:${c.vapi_assistant_id || "None"}`);
    console.log("-----------------------------------------");
  });
}

main().catch(console.error);
