/**
 * app/api/generate-video/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-video  — browser-driven, streaming path (main Generate
 * page). Segments the article, generates scene images + narration, and submits
 * the render to Remotion Lambda, streaming SSE progress. The scheduler uses the
 * durable generateVideoSteps instead (lib/workflows/generateMedia.ts), which
 * checkpoints each piece; both share the helpers in lib/videoAssets.ts.
 *
 * SSE shapes:
 *   { type: "progress",  message, elapsedSecs }
 *   { type: "submitted", renderId, bucketName, totalDurationSecs, sceneCount,
 *                        chapters, captionsSrt, elapsedSecs }
 *   { type: "error",     message }
 */

import { NextRequest, NextResponse } from "next/server";
import { segmentVideoScript } from "@/lib/videoScript";
import {
  slugify, FALLBACK_IMG,
  generateSceneImageUrl, prepareStaticAssets,
  generateNarrationAsset, rehostProvidedAudioAsset,
  buildVideoRenderSubmission,
} from "@/lib/videoAssets";

// 800s: scene images use GPT Image 2 (slow). Generated in bounded parallel here.
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const {
    title, audioUrl: providedAudioUrl,
    main_content, more_content_1, more_content_2, more_content_3,
    more_content_4, more_content_5, more_content_6, final_points,
  } = body as {
    title?: string; audioUrl?: string;
    main_content?: string; more_content_1?: string; more_content_2?: string;
    more_content_3?: string; more_content_4?: string; more_content_5?: string;
    more_content_6?: string; final_points?: string;
  };

  if (!title?.trim()) return NextResponse.json({ error: "title is required." }, { status: 400 });
  if (!process.env.REMOTION_FUNCTION_NAME) return NextResponse.json({ error: "REMOTION_FUNCTION_NAME not configured." }, { status: 503 });
  if (!process.env.REMOTION_SERVE_URL)     return NextResponse.json({ error: "REMOTION_SERVE_URL not configured." }, { status: 503 });
  if (!process.env.OPENAI_API_KEY)         return NextResponse.json({ error: "OPENAI_API_KEY not configured." }, { status: 503 });
  if (!process.env.GEMINI_API_KEY)         return NextResponse.json({ error: "GEMINI_API_KEY not configured." }, { status: 503 });
  if (!process.env.ASTON_LOGO_URL)         return NextResponse.json({ error: "ASTON_LOGO_URL not configured." }, { status: 503 });

  const logoUrl = process.env.ASTON_LOGO_URL;
  const encoder = new TextEncoder();
  const stream  = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = stream.writable.getWriter();
  const start   = Date.now();
  const elapsed = () => Math.round((Date.now() - start) / 1000);
  const send    = (e: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => {});

  (async () => {
    try {
      const hasContent = !!(main_content || more_content_1 || more_content_2);
      const scriptFields = hasContent ? {
        main_content, more_content_1, more_content_2, more_content_3,
        more_content_4, more_content_5, more_content_6, final_points,
      } : undefined;
      const slug = slugify(title.trim());

      // ── 0. Re-host static assets (logo + music) on S3 ──
      const [{ logoS3Url, musicS3Url }, timedSegments] = await Promise.all([
        prepareStaticAssets(logoUrl, process.env.BACKGROUND_MUSIC_URL ?? ""),
        (async () => {
          await send({ type: "progress", message: hasContent ? "Dividing article into video scenes…" : "Writing video script from topic…", elapsedSecs: elapsed() });
          return segmentVideoScript(title.trim(), scriptFields);
        })(),
      ]);
      console.log(`[generate-video] ${timedSegments.length} scenes segmented`);

      // ── 1. Scene images — bounded parallel, each generated + uploaded ──
      await send({ type: "progress", message: `Generating ${timedSegments.length} scene images with GPT Image 2…`, elapsedSecs: elapsed() });
      const IMAGE_CONCURRENCY = 3;
      const imageUrls: string[] = new Array(timedSegments.length).fill(FALLBACK_IMG);
      let nextImage = 0;
      let doneImages = 0;
      const imageWorker = async () => {
        while (nextImage < timedSegments.length) {
          const i = nextImage++;
          imageUrls[i] = await generateSceneImageUrl(timedSegments[i].imagePrompt, timedSegments[i].sectionTitle, slug, i);
          doneImages++;
          await send({ type: "progress", message: `Scene images ${doneImages} of ${timedSegments.length} ready…`, elapsedSecs: elapsed() });
        }
      };
      await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, timedSegments.length) }, imageWorker));
      const uploaded = imageUrls.filter((u) => u !== FALLBACK_IMG).length;
      console.log(`[generate-video] ${uploaded}/${timedSegments.length} images ready (${timedSegments.length - uploaded} fallback)`);

      // ── 2. Narration audio (generate or re-host provided) ──
      let audio: { audioUrl: string; durationSeconds: number };
      if (!providedAudioUrl?.trim()) {
        await send({ type: "progress", message: "Generating narration audio (this takes ~1–2 min)…", elapsedSecs: elapsed() });
        const script = timedSegments.map((s) => s.narration).join(" ");
        audio = await generateNarrationAsset(script, slug);
      } else {
        await send({ type: "progress", message: "Copying audio to S3 for rendering…", elapsedSecs: elapsed() });
        const totalWords = timedSegments.reduce((s, seg) => s + seg.wordCount, 0);
        audio = await rehostProvidedAudioAsset(providedAudioUrl.trim(), slug, totalWords);
      }
      console.log(`[generate-video] Audio ready (~${Math.round(audio.durationSeconds)}s)`);

      // ── 3. Calibrate + submit render ──
      await send({ type: "progress", message: "Submitting to Remotion Lambda for rendering…", elapsedSecs: elapsed() });
      const submission = await buildVideoRenderSubmission({
        segments: timedSegments, imageUrls, audioUrl: audio.audioUrl,
        audioDurationSeconds: audio.durationSeconds, logoS3Url, musicS3Url, slug,
      });
      console.log(`[generate-video] Remotion render submitted: ${submission.renderId} (bucket: ${submission.bucketName})`);

      await send({
        type:              "submitted",
        renderId:          submission.renderId,
        bucketName:        submission.bucketName,
        totalDurationSecs: submission.totalDurationSecs,
        sceneCount:        submission.sceneCount,
        chapters:          submission.chapters,
        captionsSrt:       submission.captionsSrt,
        elapsedSecs:       elapsed(),
        message:           `Rendering ${submission.sceneCount} scenes (~${Math.round(submission.totalDurationSecs / 60)} min video)…`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[generate-video] Failed: ${msg}`);
      await send({ type: "error", message: msg });
    }
  })().finally(() => writer.close().catch(() => {}));

  return new Response(stream.readable, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
