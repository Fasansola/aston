/**
 * app/api/generate-script/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-script
 *
 * Generates a segmented production script from a title + keyword.
 * Returns 7 segments with script text + HeyGen studio instructions per segment.
 *
 * Body:    { title: string, keyword?: string, language?: string }
 * Returns: { segments: ScriptSegment[], totalWords: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateSegmentedScript } from "@/lib/heygen";

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
    const segments = await generateSegmentedScript(
      title.trim(),
      keyword?.trim() || title.trim(),
      language || undefined
    );

    const totalWords = segments.reduce(
      (acc, s) => acc + s.script.split(/\s+/).filter(Boolean).length,
      0
    );

    console.log(`[generate-script] Done — ${segments.length} segments, ${totalWords} words`);
    return NextResponse.json({ segments, totalWords });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generate-script] Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
