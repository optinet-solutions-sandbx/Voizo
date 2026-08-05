import { NextRequest, NextResponse } from "next/server";
import { updateQaPrompt, deleteQaPrompt } from "@/lib/qaPromptData";

/**
 * /api/qa-prompt-testing/prompts/[id]
 *   PATCH  → update { title?, content?, isActive? } (isActive:true demotes others).
 *   DELETE → remove a prompt from the library.
 *
 * Service-role writes; origin-checked.
 */

function crossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const { id } = await ctx.params;
  let body: { title?: unknown; content?: unknown; isActive?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch: { title?: string; content?: string; isActive?: boolean } = {};
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.content === "string") patch.content = body.content;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (patch.title !== undefined && !patch.title) {
    return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  try {
    const prompt = await updateQaPrompt(id, patch);
    return NextResponse.json({ prompt });
  } catch (err) {
    console.error("[qa-prompt-testing/prompts/:id] update failed:", err);
    return NextResponse.json({ error: "Failed to update prompt" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const { id } = await ctx.params;
  try {
    await deleteQaPrompt(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[qa-prompt-testing/prompts/:id] delete failed:", err);
    return NextResponse.json({ error: "Failed to delete prompt" }, { status: 500 });
  }
}
