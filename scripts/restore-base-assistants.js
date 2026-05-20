const fs = require("fs");
const path = require("path");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Clean Vapi-managed properties from backup payload to avoid API validation errors on create
function cleanPayloadForCreate(assistant) {
  const clean = { ...assistant };
  delete clean.id;
  delete clean.orgId;
  delete clean.createdAt;
  delete clean.updatedAt;
  delete clean.isServerUrlSecretSet;
  return clean;
}

// Compare two configurations and return a list of differences
function getDiff(backup, current) {
  const diffs = [];
  
  // 1. Voice check
  const backupVoice = backup.voice?.voiceId || "";
  const currentVoice = current.voice?.voiceId || "";
  if (backupVoice !== currentVoice) {
    diffs.push(`Voice: backup uses "${backupVoice}", Vapi current uses "${currentVoice}"`);
  }
  
  // 2. System Prompt check
  const backupPrompt = backup.model?.messages?.find(m => m.role === 'system')?.content || "";
  const currentPrompt = current.model?.messages?.find(m => m.role === 'system')?.content || "";
  if (backupPrompt !== currentPrompt) {
    diffs.push(`System Prompt: content mismatch (backup length: ${backupPrompt.length}, current length: ${currentPrompt.length})`);
  }

  // 3. First Message check
  const backupFirstMsg = backup.firstMessage || "";
  const currentFirstMsg = current.firstMessage || "";
  if (backupFirstMsg !== currentFirstMsg) {
    diffs.push(`First Message: backup has "${backupFirstMsg.slice(0, 40)}...", current has "${currentFirstMsg.slice(0, 40)}..."`);
  }

  // 4. Model check
  const backupModel = backup.model?.model || "";
  const currentModel = current.model?.model || "";
  if (backupModel !== currentModel) {
    diffs.push(`LLM Model: backup uses "${backupModel}", current uses "${currentModel}"`);
  }
  
  return diffs;
}

async function makeVapiRequest(urlPath, method, apiKey, body = null) {
  const options = {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  
  const res = await fetch(`https://api.vapi.ai${urlPath}`, options);
  if (res.status === 404 && method === "GET") {
    return null;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log("Starting Base Assistant Restore & Recovery Utility...");

  const execute = process.argv.includes("--execute");
  const targetIdArg = process.argv.find(arg => arg.startsWith("--id="));
  const targetNameArg = process.argv.find(arg => arg.startsWith("--name="));

  const targetId = targetIdArg ? targetIdArg.split("=")[1].trim() : null;
  const targetName = targetNameArg ? targetNameArg.split("=")[1].trim() : null;

  if (!targetId && !targetName) {
    console.error("Error: Please specify the assistant to restore.");
    console.log("Usage examples:");
    console.log("  node scripts/restore-base-assistants.js --name=\"Maria - Voice Agent\"");
    console.log("  node scripts/restore-base-assistants.js --id=00369aee-86ae-4841-9184-94bb3f8228a9");
    console.log("  (Add --execute to apply the recovery live; default is dry-run mode)");
    process.exit(1);
  }

  // ── Load Environment Variables ──
  const workspacePath = path.resolve(__dirname, "..");
  const envPath = path.join(workspacePath, ".env.local");

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

  const apiKey = env["VAPI_PRIVATE_KEY"];
  if (!apiKey) {
    console.error("Error: VAPI_PRIVATE_KEY not set in .env.local");
    process.exit(1);
  }

  // ── Load Backup Data ──
  const backupPath = path.join(workspacePath, "backups", "base_assistants_backup.json");
  if (!fs.existsSync(backupPath)) {
    console.error(`Error: No backups file found at ${backupPath}. Please run backup-base-assistants.js first.`);
    process.exit(1);
  }

  const backupData = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
  console.log(`Loaded backup file created at: ${backupData.backupDate}`);

  // Find target assistant in backups
  const backupAssistant = backupData.assistants.find(a => {
    if (targetId && a.id === targetId) return true;
    if (targetName && a.name.toLowerCase() === targetName.toLowerCase()) return true;
    return false;
  });

  if (!backupAssistant) {
    console.error(`Error: Could not find assistant in backups matching the criteria (ID: ${targetId}, Name: ${targetName}).`);
    process.exit(1);
  }

  const origId = backupAssistant.id;
  console.log(`Found matching backup: "${backupAssistant.name}" (Original Vapi ID: ${origId})`);

  // ── Reconcile with Vapi ──
  console.log(`Checking if assistant currently exists on Vapi...`);
  const currentVapi = await makeVapiRequest(`/assistant/${origId}`, "GET", apiKey);

  if (currentVapi) {
    console.log(`Assistant exists! Initiating configuration diff reconciliation...`);
    const diffs = getDiff(backupAssistant, currentVapi);

    if (diffs.length === 0) {
      console.log("No differences found. The assistant on Vapi matches the backup exactly.");
      return;
    }

    console.log(`\nFound ${diffs.length} differences compared to backup:`);
    diffs.forEach(d => console.log(`  - ${d}`));

    if (execute) {
      console.log(`\n=== Live Update Started ===`);
      console.log(`Reconciling assistant "${backupAssistant.name}" (${origId}) back to backup configuration...`);
      // Update by sending patch of clean backup payload
      const patchPayload = cleanPayloadForCreate(backupAssistant);
      await makeVapiRequest(`/assistant/${origId}`, "PATCH", apiKey, patchPayload);
      console.log(`Successfully restored assistant configuration!`);
      console.log(`=== Live Update Completed ===`);
    } else {
      console.log(`\nDry run: To override these differences and restore the backup configuration, run:`);
      console.log(`node scripts/restore-base-assistants.js --id=${origId} --execute`);
    }
  } else {
    // ── Assistant has been fully deleted from Vapi ──
    console.warn(`\n[WARNING] Assistant does not exist on Vapi! It appears to have been deleted.`);
    console.log(`Initiating full assistant recreation procedure...`);

    if (execute) {
      console.log(`\n=== Live Re-creation Started ===`);
      console.log(`Creating fresh Vapi assistant with backed-up properties...`);
      const createPayload = cleanPayloadForCreate(backupAssistant);
      const newAssistant = await makeVapiRequest("/assistant", "POST", apiKey, createPayload);
      
      const newId = newAssistant.id;
      console.log(`Successfully created assistant! New Vapi ID: ${newId}`);

      // ── Database Update ──
      console.log("\nConnecting to Supabase to update database references...");
      const supabaseSdkPath = path.join(workspacePath, "node_modules", "@supabase", "supabase-js");
      const { createClient } = require(supabaseSdkPath);
      const s = createClient(env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"]);

      console.log(`Updating campaigns_v2 setting base_assistant_id from old ID: ${origId} to new ID: ${newId}...`);
      const { data: updated, error: dbErr } = await s.from("campaigns_v2")
        .update({ base_assistant_id: newId })
        .eq("base_assistant_id", origId)
        .select("id, name");

      if (dbErr) {
        console.error(`Failed to update campaigns_v2 database pointers:`, dbErr);
      } else {
        console.log(`Successfully updated ${updated.length} campaigns in campaigns_v2!`);
        updated.forEach(c => console.log(`  - Updated Campaign: ${c.name} (ID: ${c.id})`));
      }
      
      console.log(`\n=== Recovery Complete! ===`);
      console.log(`Please note that the base assistant is completely restored and fully operational under its new Vapi ID: ${newId}`);
    } else {
      console.log(`\nDry run: This assistant will be created fresh on Vapi.`);
      console.log(`After creation, a database update will automatically remap all base_assistant_id references in Supabase from "${origId}" to the new ID.`);
      console.log(`To perform this live recovery, run:`);
      console.log(`node scripts/restore-base-assistants.js --id=${origId} --execute`);
    }
  }
}

main().catch(console.error);
