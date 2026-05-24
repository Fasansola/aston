/**
 * app/api/generate-script/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-script
 *
 * Generates a natural spoken-word video script from a title + keyword.
 * Returns plain JSON — no streaming needed (GPT responds in ~5–10s).
 *
 * Body:  { title: string, keyword?: string, language?: string }
 * Returns: { script: string, wordCount: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateVideoScript } from "@/lib/heygen";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { title, keyword, language } = body as {
    title?: string;
    keyword?: string;
    language?: string;
  };

  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required." }, { status: 400 });
  }

  try {
    const script = await generateVideoScript(
      title.trim(),
      keyword?.trim() || title.trim(),
      language || undefined
    );

    const wordCount = script.split(/\s+/).filter(Boolean).length;
    console.log(`[generate-script] Done — ${wordCount} words`);

    return NextResponse.json({ script, wordCount });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-script] Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
