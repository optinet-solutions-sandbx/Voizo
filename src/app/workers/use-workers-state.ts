// src/app/workers/use-workers-state.ts
//
// Polls GET /api/workers/state every 5s (per design doc §5.2) and exposes:
//   { data, loading, error, refresh }
//
// The endpoint shape is the same as the prior workers/page.tsx — server-side
// aggregation of vapi_sip_pool + campaigns_v2 + active calls_v2.

"use client";

import { useCallback, useEffect, useState } from "react";
import { parseJsonBody } from "@/lib/jsonBody";

// ─────────────────────────────────────────────────────────────────────────
// Types — match the API response.
// Could be lifted to src/lib/types/workers.ts if shared with the server.
// ─────────────────────────────────────────────────────────────────────────

export interface InFlightCall {
  callId: string;
  vapiCallId: string | null;
  phoneE164: string | null;
  status: string;
  startedAt: string;
  durationMs: number;
}

export interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  timezone: string;
  vapiAssistantName: string | null;
}

export interface WorkerSlot {
  slotIndex: number;
  slotLabel: string;
  status: "free" | "leased" | "maintenance";
  sipUri: string;
  leasedAt: string | null;
  leasedDurationMs: number | null;
  campaign: CampaignInfo | null;
  inFlightCall: InFlightCall | null;
  notes: string | null;
}

export interface WorkersStateResponse {
  fetchedAt: string;
  slots: WorkerSlot[];
}

// ─────────────────────────────────────────────────────────────────────────

const POLL_MS = 5000;

export function useWorkersState() {
  const [data, setData] = useState<WorkersStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workers/state", { cache: "no-store" });
      if (!res.ok) {
        const body = await parseJsonBody(res);
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as WorkersStateResponse;
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workers state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await load();
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [load]);

  return { data, loading, error, refresh: load };
}
