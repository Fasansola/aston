/**
 * app/api/generate-video/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-video
 *
 * Generates the video only — does NOT upload to YouTube.
 * The client previews the video first, then calls /api/upload-video
 * when the user clicks "Upload to YouTube".
 *
 * SSE event shapes:
 *   { type: "progress", message: string, elapsedSecs: number }
 *   { type: "done",     videoBase64: string, mimeType: string }
 *   { type: "error",    message: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateVideoPrompt, generateVeoVideo } from "@/lib/video";

export const maxDuration = 300;

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

  const encoder = new TextEncoder();
  const stream  = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = stream.writable.getWriter();
  const start   = Date.now();

  const send = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});

  (async () => {
    try {
      // ── Step 1: write cinematic prompt ───────────────────────
      const elapsedSecs = () => Math.round((Date.now() - start) / 1000);
      await send({ type: "progress", message: "Writing video prompt…", elapsedSecs: elapsedSecs() });
      const prompt = await generateVideoPrompt(
        title.trim(),
        keyword?.trim() || title.trim(),
        language || undefined
      );
      console.log(`[generate-video] Prompt: ${prompt.slice(0, 120)}…`);

      // ── Step 2: generate video via Veo 2 ─────────────────────
      const videoBuffer = await generateVeoVideo(
        prompt,
        (msg) => {
          console.log(`[generate-video] ${msg}`);
          send({ type: "progress", message: msg, elapsedSecs: elapsedSecs() });
        },
        240_000
      );
      console.log(`[generate-video] Video ready — ${videoBuffer.length} bytes in ${elapsedSecs()}s`);

      // Return the video as base64 so the client can preview it immediately
      await send({
        type: "done",
        videoBase64: videoBuffer.toString("base64"),
        mimeType: "video/mp4",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[generate-video] Failed: ${msg}`);
      await send({ type: "error", message: msg });
    }
  })().finally(() => writer.close().catch(() => {}));

  return new Response(stream.readable, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
