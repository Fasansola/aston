/**
 * app/api/generate-video/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-video
 *
 * Pipeline:
 *   1. Segment article into 7 scenes (GPT-4o-mini)
 *   2. Generate 7 background images in parallel (Imagen 4)
 *   3. Upload images to WP media (public URLs for Shotstack)
 *   4. Ensure narration audio (use provided audioUrl or generate TTS)
 *   5. Submit timeline to Shotstack → returns renderId immediately
 *
 * Render is async on Shotstack — client polls /api/check-video-render
 *
 * SSE shapes:
 *   { type: "progress",  message, elapsedSecs }
 *   { type: "submitted", renderId, totalDurationSecs, sceneCount, elapsedSecs }
 *   { type: "error",     message }
 */

import { NextRequest, NextResponse } from "next/server";
import { segmentVideoScript }        from "@/lib/videoScript";
import { submitShotstackRender, type VideoSegment } from "@/lib/shotstack";
import { uploadImageToWordPress, uploadMediaToWordPress } from "@/lib/wordpress";
import { generateKokoroSpeech, articleToAudioScript }    from "@/lib/replicate";

export const maxDuration = 300;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

async function generateSceneImage(prompt: string): Promise<Buffer> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt: `Cinematic 16:9 background image for a professional corporate video. ${prompt} No people, no text, no logos.`,
    config: { numberOfImages: 1, aspectRatio: "16:9", outputMimeType: "image/png" },
  });
  const imageData = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imageData) throw new Error("Imagen 4 returned no image data");
  return Buffer.from(imageData, "base64");
}

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
  if (!process.env.SHOTSTACK_API_KEY) return NextResponse.json({ error: "SHOTSTACK_API_KEY not configured." }, { status: 503 });
  if (!GEMINI_API_KEY) return NextResponse.json({ error: "GEMINI_API_KEY not configured." }, { status: 503 });
  if (!process.env.ASTON_LOGO_URL) return NextResponse.json({ error: "ASTON_LOGO_URL not configured." }, { status: 503 });

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

      // ── 1. Segment script ─────────────────────────────────────
      const segMsg = hasContent
        ? "Dividing article into video scenes…"
        : "Writing video script from topic…";
      await send({ type: "progress", message: segMsg, elapsedSecs: elapsed() });
      const timedSegments = await segmentVideoScript(title.trim(), scriptFields);
      const totalDurationSecs = timedSegments.reduce((s, seg) => s + seg.durationSeconds, 0);
      console.log(`[generate-video] ${timedSegments.length} scenes, ~${totalDurationSecs}s`);

      // ── 2. Generate background images in parallel ─────────────
      await send({ type: "progress", message: `Generating ${timedSegments.length} background images…`, elapsedSecs: elapsed() });
      const imageBuffers = await Promise.all(
        timedSegments.map((seg, i) =>
          generateSceneImage(seg.imagePrompt).catch((err) => {
            console.warn(`[generate-video] Scene image ${i + 1} failed: ${err.message}`);
            return null;
          })
        )
      );

      // ── 3. Upload images to WP media ──────────────────────────
      await send({ type: "progress", message: "Uploading scene images…", elapsedSecs: elapsed() });
      const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const FALLBACK_IMG = "https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/images/motionsarray/motionarray-1009154.jpg";

      const imageUrls = await Promise.all(
        imageBuffers.map(async (buf, i) => {
          if (!buf) return FALLBACK_IMG;
          const { url } = await uploadImageToWordPress(buf, `${slug}-scene-${i + 1}.png`, `Video scene ${i + 1}`);
          return url;
        })
      );

      // ── 4. Ensure narration audio ─────────────────────────────
      let audioUrl = providedAudioUrl?.trim() || "";
      if (!audioUrl) {
        await send({ type: "progress", message: "Generating narration audio…", elapsedSecs: elapsed() });
        // Build narration from the segments (works in both article and standalone mode)
        const script = hasContent && scriptFields
          ? articleToAudioScript(title.trim(), scriptFields)
          : timedSegments.map((s) => s.narration).join(" ");
        const { buffer: audioBuf, mimeType } = await generateKokoroSpeech(script);
        const ext = mimeType === "audio/mpeg" ? "mp3" : "wav";
        const { url } = await uploadMediaToWordPress(audioBuf, `${slug}-video-audio.${ext}`, mimeType);
        audioUrl = url;
        console.log(`[generate-video] Narration audio uploaded: ${audioUrl}`);
      }

      // ── 5. Submit to Shotstack ────────────────────────────────
      await send({ type: "progress", message: "Submitting to Shotstack for rendering…", elapsedSecs: elapsed() });

      const videoSegments: VideoSegment[] = timedSegments.map((seg, i) => ({
        sectionTitle:    seg.sectionTitle,
        displayText:     seg.displayText,
        durationSeconds: seg.durationSeconds,
        imageUrl:        imageUrls[i],
      }));

      const renderId = await submitShotstackRender(videoSegments, audioUrl, logoUrl);
      console.log(`[generate-video] Render submitted: ${renderId}`);

      await send({
        type:             "submitted",
        renderId,
        totalDurationSecs,
        sceneCount:       timedSegments.length,
        elapsedSecs:      elapsed(),
        message:          `Rendering ${timedSegments.length} scenes (~${Math.round(totalDurationSecs / 60)} min video)…`,
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
