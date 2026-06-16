"use client";

// Resolves campaigns_v2.base_assistant_id → the BASE agent's real name. The cloned
// assistant's name == the campaign title (redundant), so we show the root base agent
// instead (Jasiel 2026-06-15). Names live in Vapi (/api/vapi/assistants, base agents
// only — clones are filtered out there). Module-level cache + in-flight dedup so the
// Vapi call happens once per page load no matter how many components ask.

import { useEffect, useState } from "react";

let cache: Map<string, string> | null = null;
let inflight: Promise<Map<string, string>> | null = null;

function loadMap(): Promise<Map<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/vapi/assistants", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { assistants: [] }))
      .then((body: { assistants?: { id: string; name: string }[] }) => {
        const m = new Map<string, string>();
        for (const a of body.assistants ?? []) m.set(a.id, a.name);
        cache = m;
        return m;
      })
      .catch(() => {
        const m = new Map<string, string>();
        cache = m; // cache the empty map so a failing endpoint isn't hammered
        return m;
      });
  }
  return inflight;
}

/** Returns a resolver: baseAssistantId → real base-agent name (null if unknown/unmapped). */
export function useBaseAgentNames(): (id: string | null | undefined) => string | null {
  const [map, setMap] = useState<Map<string, string> | null>(cache);
  useEffect(() => {
    let alive = true;
    loadMap().then((m) => {
      if (alive) setMap(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (id) => (id && map ? (map.get(id) ?? null) : null);
}
