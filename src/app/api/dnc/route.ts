import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET  /api/dnc          — list all suppression entries
 * POST /api/dnc          — insert one or more phone numbers
 * DELETE /api/dnc?id=xxx — hard-delete a single entry by UUID
 *
 * All mutations go through supabaseAdmin (service-role) so the
 * anon key never touches the suppression_list table.
 */

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("suppression_list")
    .select("*")
    .order("added_at", { ascending: false });

  if (error) {
    console.error("[dnc] fetch failed:", error);
    return NextResponse.json({ error: "Failed to fetch suppression list" }, { status: 500 });
  }

  return NextResponse.json({ entries: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.phoneNumbers) || body.phoneNumbers.length === 0) {
    return NextResponse.json({ error: "phoneNumbers array required" }, { status: 400 });
  }

  const trimmed: string[] = body.phoneNumbers
    .map((n: unknown) => (typeof n === "string" ? n.trim() : ""))
    .filter(Boolean);

  if (trimmed.length === 0) {
    return NextResponse.json({ error: "No valid phone numbers" }, { status: 400 });
  }

  const rows = trimmed.map((n) => ({
    phone_e164: n,
    reason: "manual",
    added_by: "operator",
  }));

  const { data, error } = await supabaseAdmin
    .from("suppression_list")
    .upsert(rows, { onConflict: "phone_e164", ignoreDuplicates: true })
    .select();

  if (error) {
    console.error("[dnc] insert failed:", error);
    return NextResponse.json({ error: "Failed to insert" }, { status: 500 });
  }

  return NextResponse.json({ entries: data ?? [] });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Valid id parameter required" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("suppression_list")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[dnc] delete failed:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
