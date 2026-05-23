/**
 * app/api/generate-heygen-video/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-heygen-video
 *
 * Generates a HeyGen avatar video from a title/keyword (auto-script)
 * or a raw script provided directly.
 *
 * SSE event shapes:
 *   { type: "progress", message: string, elapsedSecs: number }
 *   { type: "done",     videoUrl: string, script: string, duration: number }
 *   { type: "error",    message: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateVideoScript, createHeyGenVideo, pollHeyGenVideo } from "@/lib/heygen";
import { generateSpeech } from "@/lib/elevenlabs";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { title, keyword, language, script: rawScript } = body as {
    title?: string;
    keyword?: string;
    language?: string;
    script?: string;
  };

  // Must have either a title or a raw script
  if (!title?.trim() && !rawScript?.trim()) {
    return NextResponse.json({ error: "Either title or script is required." }, { status: 400 });
  }

  const missingVars = ["HEYGEN_API_KEY", "HEYGEN_AVATAR_ID", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]
    .filter((k) => !process.env[k]);
  if (missingVars.length > 0) {
    return NextResponse.json(
      { error: `HeyGen not configured. Missing: ${missingVars.join(", ")}` },
      { status: 503 }
    );
  }

  const encoder = new TextEncoder();
  const stream  = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = stream.writable.getWriter();
  const start   = Date.now();

  const send = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});

  (async () => {
    try {
      const elapsedSecs = () => Math.round((Date.now() - start) / 1000);

      // ── Step 1: script ──────────────────────────────────────────
      let script: string;
      if (rawScript?.trim()) {
        script = rawScript.trim();
        await send({ type: "progress", message: "Using provided script…", elapsedSecs: elapsedSecs() });
      } else {
        await send({ type: "progress", message: "Writing video script…", elapsedSecs: elapsedSecs() });
        script = await generateVideoScript(
          title!.trim(),
          keyword?.trim() || title!.trim(),
          language || undefined
        );
        await send({ type: "progress", message: "Script ready — submitting to HeyGen…", elapsedSecs: elapsedSecs() });
      }

      // ── Step 2: generate audio via ElevenLabs ──────────────────
      await send({ type: "progress", message: "Generating voice audio with ElevenLabs…", elapsedSecs: elapsedSecs() });
      const audioBuffer = await generateSpeech(script);
      console.log(`[generate-heygen-video] Audio ready — ${(audioBuffer.length / 1024).toFixed(1)} KB`);

      // ── Step 3: create HeyGen video ─────────────────────────────
      await send({ type: "progress", message: "Uploading audio and submitting to HeyGen…", elapsedSecs: elapsedSecs() });
      const videoId = await createHeyGenVideo(audioBuffer, title?.trim());
      await send({ type: "progress", message: "HeyGen is rendering your 1080p avatar video…", elapsedSecs: elapsedSecs() });

      // ── Step 3: poll until done ─────────────────────────────────
      const { videoUrl, duration } = await pollHeyGenVideo(
        videoId,
        (msg) => {
          console.log(`[generate-heygen-video] ${msg}`);
          send({ type: "progress", message: msg, elapsedSecs: elapsedSecs() });
        },
        270_000 // 4.5-min deadline — within Vercel's 300s maxDuration
      );

      console.log(`[generate-heygen-video] Done in ${elapsedSecs()}s — ${videoUrl.slice(0, 80)}…`);

      await send({ type: "done", videoUrl, script, duration, elapsedSecs: elapsedSecs() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[generate-heygen-video] Failed: ${msg}`);
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
