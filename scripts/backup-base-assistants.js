const fs = require("fs");
const path = require("path");

const BASE_ASSISTANT_IDS = [
  "00369aee-86ae-4841-9184-94bb3f8228a9", // Maria - Voice Agent
  "d0fd168b-47c2-48bd-915c-50bb7f47fe80", // Maria - Voice Agent (Copy)
  "3b0c2ad0-db3c-4e80-ac99-57fa66f1bf78", // Ernie - Voice Agent
  "7255c115-c24d-429a-a0d7-8697637a417c", // Val - Voice Agent
  "bab885f4-5771-4edf-a45a-bbc56c7d9960", // Gisela - Voice Agent
  "86506bbd-bbf0-465e-82bb-b9d4e4a77ecc", // Janice - Voice Agent
  "f789a4aa-e024-4798-b5a3-127317066222", // Nikhilesh - Voice Agent
  "012ed20b-bac9-4628-b822-a47ed6c2f75b", // Alex - Voice Agent
  "509156f5-78b7-4644-901a-acbc3415472d", // Meny - Voice Agent
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAssistant(id, apiKey, retries = 5) {
  const options = {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  };
  
  try {
    const res = await fetch(`https://api.vapi.ai/assistant/${id}`, options);
    
    if (res.status === 429) {
      if (retries > 0) {
        const retryAfter = 5000;
        console.warn(`[Rate Limited 429] Retrying fetching ${id} in ${retryAfter}ms... (${retries} retries left)`);
        await delay(retryAfter);
        return fetchAssistant(id, apiKey, retries - 1);
      }
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  } catch (err) {
    if (retries > 0 && err.message.includes("429")) {
      const retryAfter = 5000;
      console.warn(`[Rate Limited Catch] Retrying fetching ${id} in ${retryAfter}ms... (${retries} retries left)`);
      await delay(retryAfter);
      return fetchAssistant(id, apiKey, retries - 1);
    }
    throw err;
  }
}

async function main() {
  console.log("Starting Base Assistant Backup Utility...");
  
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

  console.log(`Backing up ${BASE_ASSISTANT_IDS.length} base assistants...`);
  const backedUpAssistants = [];

  for (const id of BASE_ASSISTANT_IDS) {
    try {
      console.log(`Fetching configuration for assistant ID: ${id}...`);
      const assistant = await fetchAssistant(id, apiKey);
      console.log(`  - Successfully fetched: "${assistant.name}"`);
      backedUpAssistants.push(assistant);
    } catch (err) {
      console.error(`  - Failed to fetch assistant ${id}: ${err.message}`);
    }
    await delay(1000); // 1s delay to prevent rate limiting
  }

  // ── Write Backup File ──
  const backupsDir = path.join(workspacePath, "backups");
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const backupPath = path.join(backupsDir, "base_assistants_backup.json");
  const backupPayload = {
    backupDate: new Date().toISOString(),
    assistants: backedUpAssistants,
  };

  fs.writeFileSync(backupPath, JSON.stringify(backupPayload, null, 2), "utf-8");
  console.log(`\nBase Assistant Backup Completed Successfully!`);
  console.log(`Saved ${backedUpAssistants.length} assistants to: ${backupPath}`);
}

main().catch(console.error);
