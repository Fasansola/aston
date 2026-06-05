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
import { segmentVideoScript, calibrateSegmentDurations } from "@/lib/videoScript";
import { submitShotstackRender, type VideoSegment }      from "@/lib/shotstack";
import { uploadImageToWordPress, uploadMediaToWordPress } from "@/lib/wordpress";
import { generateKokoroSpeech, articleToAudioScript, estimateMp3DurationSeconds } from "@/lib/replicate";

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
      console.log(`[generate-video] ${timedSegments.length} scenes segmented`);

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

      // ── 3. Upload images to WP media — sequential with delay ─────
      // SiteGround's Anti-Bot (SGCaptcha) blocks parallel upload bursts
      // from Vercel IPs. Uploading one at a time with a 1.2s gap between
      // each request avoids the rate-limit trigger.
      await send({ type: "progress", message: "Uploading scene images…", elapsedSecs: elapsed() });
      const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const FALLBACK_IMG = "https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/images/motionsarray/motionarray-1009154.jpg";

      const imageUrls: string[] = [];
      for (let i = 0; i < imageBuffers.length; i++) {
        const buf = imageBuffers[i];
        if (!buf) {
          imageUrls.push(FALLBACK_IMG);
          continue;
        }
        try {
          const { url } = await uploadImageToWordPress(buf, `${slug}-scene-${i + 1}.png`, `Video scene ${i + 1}`);
          imageUrls.push(url);
        } catch (err) {
          console.warn(`[generate-video] Image ${i + 1} upload failed: ${err instanceof Error ? err.message : err}`);
          imageUrls.push(FALLBACK_IMG);
        }
        // Pause between uploads to avoid triggering SiteGround's Anti-Bot
        if (i < imageBuffers.length - 1) {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      console.log(`[generate-video] Uploaded ${imageUrls.filter(u => u !== FALLBACK_IMG).length}/${imageBuffers.length} images`);

      // ── 4. Generate narration audio + measure real duration ──────
      // We use the actual audio file size to calculate each segment's
      // precise slice of the timeline — this is what keeps the background
      // image and text in sync with what's being narrated.
      let audioUrl = providedAudioUrl?.trim() || "";
      let audioDurationSeconds = 0;

      if (!audioUrl) {
        await send({ type: "progress", message: "Generating narration audio…", elapsedSecs: elapsed() });
        const script = hasContent && scriptFields
          ? articleToAudioScript(title.trim(), scriptFields)
          : timedSegments.map((s) => s.narration).join(" ");
        const { buffer: audioBuf, mimeType } = await generateKokoroSpeech(script);
        audioDurationSeconds = estimateMp3DurationSeconds(audioBuf);
        const ext = mimeType === "audio/mpeg" ? "mp3" : "wav";
        const { url } = await uploadMediaToWordPress(audioBuf, `${slug}-video-audio.${ext}`, mimeType);
        audioUrl = url;
        console.log(`[generate-video] Audio uploaded: ${audioUrl} (~${Math.round(audioDurationSeconds)}s)`);
      } else {
        // Provided audio URL — estimate from total word count
        const totalWords = timedSegments.reduce((s, seg) => s + seg.wordCount, 0);
        audioDurationSeconds = (totalWords / 130) * 60;
        console.log(`[generate-video] Provided audio, estimated duration: ~${Math.round(audioDurationSeconds)}s`);
      }

      // ── 5. Calibrate every segment duration to the real audio ─────
      // Proportional split: segment_duration = (segment_words / total_words) × audio_duration
      // This guarantees images change exactly when the narration moves to the next scene.
      const calibrated = audioDurationSeconds > 0
        ? calibrateSegmentDurations(timedSegments, audioDurationSeconds)
        : timedSegments;
      const totalDurationSecs = calibrated.reduce((s, seg) => s + seg.durationSeconds, 0);
      console.log(`[generate-video] Scene durations: ${calibrated.map(s => Math.round(s.durationSeconds) + "s").join(", ")}`);

      // ── 6. Submit to Shotstack ────────────────────────────────────
      await send({ type: "progress", message: "Submitting to Shotstack for rendering…", elapsedSecs: elapsed() });

      const videoSegments: VideoSegment[] = calibrated.map((seg, i) => ({
        sectionTitle:    seg.sectionTitle,
        displayText:     seg.displayText,
        durationSeconds: seg.durationSeconds,
        imageUrl:        imageUrls[i],
      }));

      const renderId = await submitShotstackRender(videoSegments, audioUrl, logoUrl);
      console.log(`[generate-video] Render submitted: ${renderId}`);

      await send({
        type:         "submitted",
        renderId,
        totalDurationSecs,
        sceneCount:   timedSegments.length,
        elapsedSecs:  elapsed(),
        message:      `Rendering ${timedSegments.length} scenes (~${Math.round(totalDurationSecs / 60)} min video)…`,
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
