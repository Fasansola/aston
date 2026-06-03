/**
 * app/api/generate-audio/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-audio
 *
 * Generates a spoken-word MP3 of a blog post using Kokoro 82M via Replicate,
 * uploads it to the WordPress media library, and saves the URL to the post's
 * ACF `audio_url` field.
 *
 * SSE event shapes:
 *   { type: "progress", message: string, elapsedSecs: number }
 *   { type: "done",     audioUrl: string, elapsedSecs: number }
 *   { type: "error",    message: string }
 *
 * Body: {
 *   postId:        number   — WordPress post ID to update
 *   title:         string   — article title (used as script opener)
 *   key_takeaways?:  string
 *   main_content?:   string
 *   more_content_1?: string
 *   more_content_2?: string
 *   more_content_5?: string  (FAQ)
 *   final_points?:   string
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateKokoroSpeech, articleToAudioScript } from "@/lib/replicate";
import { uploadMediaToWordPress } from "@/lib/wordpress";
import { updatePostAudioUrl } from "@/lib/video";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const {
    postId,
    title,
    main_content,
    more_content_1,
    more_content_2,
    more_content_3,
    more_content_4,
    more_content_5,
    more_content_6,
    final_points,
  } = body as {
    postId?: number;
    title?: string;
    main_content?: string;
    more_content_1?: string;
    more_content_2?: string;
    more_content_3?: string;
    more_content_4?: string;
    more_content_5?: string;
    more_content_6?: string;
    final_points?: string;
  };

  if (!postId || typeof postId !== "number") {
    return NextResponse.json({ error: "postId is required." }, { status: 400 });
  }
  if (!title?.trim()) {
    return NextResponse.json({ error: "title is required." }, { status: 400 });
  }
  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "Replicate not configured. Missing REPLICATE_API_TOKEN." },
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

      // ── Step 1: Build plain-text script from article fields ──
      await send({ type: "progress", message: "Building audio script from article…", elapsedSecs: elapsedSecs() });
      const script = articleToAudioScript(title.trim(), {
        main_content,
        more_content_1,
        more_content_2,
        more_content_3,
        more_content_4,
        more_content_5,
        more_content_6,
        final_points,
      });
      const wordCount = script.split(/\s+/).filter(Boolean).length;
      console.log(`[generate-audio] Script ready — ${wordCount} words`);

      // ── Step 2: Generate speech via Kokoro on Replicate ──────
      await send({ type: "progress", message: `Generating speech via Kokoro (${wordCount} words)…`, elapsedSecs: elapsedSecs() });
      const { buffer, mimeType } = await generateKokoroSpeech(script);
      await send({ type: "progress", message: "Audio ready — uploading to WordPress…", elapsedSecs: elapsedSecs() });

      // ── Step 3: Upload audio to WordPress media library ──────
      const ext      = mimeType === "audio/mpeg" ? "mp3" : "wav";
      const filename = `${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-audio.${ext}`;
      const { id: audioMediaId, url: audioUrl } = await uploadMediaToWordPress(buffer, filename, mimeType);
      console.log(`[generate-audio] Uploaded to WordPress: mediaId=${audioMediaId} ${audioUrl}`);

      // ── Step 4: Save URL to ACF field ────────────────────────
      await send({ type: "progress", message: "Saving audio URL to WordPress post…", elapsedSecs: elapsedSecs() });
      await updatePostAudioUrl(postId, audioUrl);
      console.log(`[generate-audio] ACF audio_url updated on post ${postId}`);

      await send({ type: "done", audioUrl, audioMediaId, elapsedSecs: elapsedSecs() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[generate-audio] Failed: ${msg}`);
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
