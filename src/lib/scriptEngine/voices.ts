export const VOICE_OPTIONS = [
  // Val's picks. NOTE: voiceIds must stay unique in this list — they are the
  // <option> values; "Val - Mark - Natural Conversations" REPLACED the old
  // "Mark – Dynamic, Balanced and Emotional" label (same UgBBYS2s… voice).
  // ⚠ These labels are HUMAN-TYPED TEXT, not the voices' real identities — the
  // ids live in Val's ElevenLabs account and neither the Vapi API nor its
  // dashboard can name them. Gender annotations below were verified BY EAR on
  // live production calls (2026-07-30 incident: a FEMALE voice labelled "Mark"
  // introduced itself as Victor on real campaigns). Ear-test before ever
  // pointing a campaign at a voice from this list.
  { label: "Val - Mark - Casual & Relaxed",           provider: "11labs", voiceId: "1SM7GgM6IMuvQlz2BwM3" }, // FEMALE (ear-verified 2026-07-30, despite the name)
  { label: "Val - Mark - Natural Conversations",      provider: "11labs", voiceId: "UgBBYS2sOqTuMpoF3BR0" }, // MALE (ear-verified 2026-07-30) — the production voice, pinned in EXPECTED_SCRIPT_BASE
  { label: "Val - Cal - Casual and Natural",          provider: "11labs", voiceId: "aqXKinCxkMOvW6f3qU8l" }, // gender UNVERIFIED
  { label: "Val - Hope - Natural, clear",             provider: "11labs", voiceId: "OYTbf65OHHFELVut7v2H" }, // FEMALE (the 2026-07-28/29 incident voice)
  { label: "Stephen – Sales and Customer Service",    provider: "11labs", voiceId: "3jR9BuQAOPMWUjWpi0ll" },
  { label: "Jackson – American Tech Sales Rep",       provider: "11labs", voiceId: "2zGvynULFssveGrcP8hi" },
  { label: "George – Natural, Full and Confident",    provider: "11labs", voiceId: "YaarrMwvJxVUpjbZ2RpC" },
  { label: "Alex – Professional",                     provider: "11labs", voiceId: "pHqSZYhjNK8nDCPRglTL" },
  { label: "Matthew Logovik",                         provider: "11labs", voiceId: "1IthILLNX448pH19aMvC" },
  { label: "Voice A (7EzWGsX1…)",                     provider: "11labs", voiceId: "7EzWGsX10sAS4c9m9cPf" },
  { label: "Voice B (8fcyCHOz…)",                     provider: "11labs", voiceId: "8fcyCHOzlKDlxh1InJSf" },
  { label: "Voice C (sUzXYdok…)",                     provider: "11labs", voiceId: "sUzXYdokj3o9QQ91yPRF" },
  { label: "Voice D (E5vwBa1s…)",                     provider: "11labs", voiceId: "E5vwBa1swCEXshQFkLEu" },
  { label: "Voice E (4e32WqNV…)",                     provider: "11labs", voiceId: "4e32WqNVWRquDa1OcRYZ" },
  { label: "Voice F (mBqbvkxI…)",                     provider: "11labs", voiceId: "mBqbvkxIFe5HjjaoiN4P" },
  { label: "Voice G (e243k3Nw…)",                     provider: "11labs", voiceId: "e243k3NwaO5uqjBb8yKV" },
  { label: "Voice H (I1ejplf7…)",                     provider: "11labs", voiceId: "I1ejplf72DWHJzwAiw4n" },
] as const;
