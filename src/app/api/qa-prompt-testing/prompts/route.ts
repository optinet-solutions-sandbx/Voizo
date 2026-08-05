import { NextRequest, NextResponse } from "next/server";
import { listQaPrompts, createQaPrompt } from "@/lib/qaPromptData";

/**
 * /api/qa-prompt-testing/prompts
 *   GET  → the QA prompt library (active first).
 *   POST → create a prompt { title, content, isActive? }.
 *
 * Behind the Basic-Auth middleware; reads/writes via service role
 * (listener_qa_prompts is default-deny to the anon key). Origin-checked so a
 * cross-site POST can't create library rows.
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

export async function GET(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  try {
    const prompts = await listQaPrompts();
    return NextResponse.json({ prompts });
  } catch (err) {
    console.error("[qa-prompt-testing/prompts] list failed:", err);
    return NextResponse.json({ error: "Failed to load prompts" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  let body: { title?: unknown; content?: unknown; isActive?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (!content.trim()) return NextResponse.json({ error: "content is required" }, { status: 400 });
  try {
    const prompt = await createQaPrompt({ title, content, isActive: body.isActive === true });
    return NextResponse.json({ prompt });
  } catch (err) {
    console.error("[qa-prompt-testing/prompts] create failed:", err);
    return NextResponse.json({ error: "Failed to create prompt" }, { status: 500 });
  }
}
