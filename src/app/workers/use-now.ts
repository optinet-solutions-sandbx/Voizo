// src/app/workers/use-now.ts
//
// 1-second tick used to keep call durations, local clocks, and the sync
// stamp updating live. Component-local — no shared singleton.

"use client";

import { useEffect, useState } from "react";

export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
