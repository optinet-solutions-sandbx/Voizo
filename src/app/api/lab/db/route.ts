// POST /api/lab/db — the Builder UIs' single DB doorway (workstream E, VOZ-116).
//
// Browsers used to hit Supabase directly with the public anon key, which
// forced allow-all RLS on the lab tables. Now every Builder read/write comes
// here as { fn, args }, is checked against the shared allow-list, and runs
// server-side on the service-role client — so the lab tables can go
// default-deny without breaking the UI.
//
// Auth: NOT in middleware's PUBLIC_PATH_PREFIXES → Basic Auth (operator-only),
// like every other dashboard API route.
import { NextRequest, NextResponse } from "next/server";
import * as labDb from "@/lib/scriptEngine/lab-db";
import { isAllowedLabDbFn } from "@/lib/scriptEngine/lab-db-rpc";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { fn?: unknown; args?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { fn, args } = body;
  if (typeof fn !== "string" || !isAllowedLabDbFn(fn)) {
    return NextResponse.json({ error: `Unknown lab-db function: ${String(fn).slice(0, 60)}` }, { status: 400 });
  }
  if (!Array.isArray(args)) {
    return NextResponse.json({ error: "args must be an array" }, { status: 400 });
  }

  try {
    // fn is allow-list-narrowed, so this indexes only the 24 exported
    // browser-surface functions — never the prototype chain.
    const impl = labDb[fn] as (...a: unknown[]) => Promise<unknown>;
    const data = await impl(...args);
    return NextResponse.json({ data: data ?? null });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : `lab-db ${fn} failed` },
      { status: 500 },
    );
  }
}
