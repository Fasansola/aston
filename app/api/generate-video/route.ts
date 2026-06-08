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
import { GoogleGenAI }                                   from "@google/genai";
import { segmentVideoScript, calibrateSegmentDurations } from "@/lib/videoScript";
import { submitRemotionRender }                          from "@/lib/remotionRenderer";
import type { VideoSegment }                             from "@/src/remotion/VideoComposition";
import { uploadSceneImageToS3, uploadAssetToS3 }         from "@/lib/sceneImageS3";
import { uploadMediaToWordPress }                        from "@/lib/wordpress";
import { generateKokoroSpeech, articleToAudioScript, estimateMp3DurationSeconds } from "@/lib/replicate";

export const maxDuration = 300;

// Dark navy 1×1 PNG — used when image generation fails so Remotion always has a valid URL.
const FALLBACK_IMG = "https://placehold.co/1280x720/0f1a2e/0f1a2e.png";

async function generateSceneImage(prompt: string): Promise<Buffer> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const response = await ai.models.generateImages({
    model:  "imagen-4.0-generate-001",
    prompt: `Professional cinematic 16:9 photograph for a corporate advisory video. ${prompt} No human figures, faces, hands, or body parts. No text, words, letters, numbers, signage, labels, logos, or writing of any kind.`,
    config: {
      numberOfImages: 1,
      aspectRatio:    "16:9",
      outputMimeType: "image/jpeg",
      negativePrompt: "people, faces, hands, silhouettes, human figures, text, words, letters, numbers, signs, labels, logos, watermarks, typography, captions, subtitles, writing, handwriting",
    },
  });

  const imgBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imgBytes) throw new Error("Imagen 4 returned no image bytes");
  return Buffer.from(imgBytes, "base64");
}

// Fetches the logo from its source URL and re-uploads to S3 so Lambda can
// load it reliably (SiteGround blocks many AWS IP ranges).
async function fetchLogoToS3(logoUrl: string): Promise<string> {
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Logo fetch failed: ${res.status}`);
    const buf         = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/svg+xml";
    const ext         = contentType.includes("svg") ? "svg" : "png";
    return await uploadAssetToS3(buf, `aston-logo.${ext}`, contentType);
  } catch (err) {
    console.warn(`[generate-video] Logo S3 upload failed, using original URL: ${err instanceof Error ? err.message : err}`);
    return logoUrl;
  }
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

      // ── 0. Upload logo to S3 so Lambda can load it reliably ──
      const logoS3Url = await fetchLogoToS3(logoUrl);

      // ── 1. Segment script ─────────────────────────────────────
      const segMsg = hasContent
        ? "Dividing article into video scenes…"
        : "Writing video script from topic…";
      await send({ type: "progress", message: segMsg, elapsedSecs: elapsed() });
      const timedSegments = await segmentVideoScript(title.trim(), scriptFields);
      console.log(`[generate-video] ${timedSegments.length} scenes segmented`);

      // ── 2. Generate background images — one at a time with progress ─
      // Running sequentially avoids overwhelming Imagen 4 and gives the
      // user live feedback on each scene instead of a long silent wait.
      const imageBuffers: (Buffer | null)[] = [];
      for (let i = 0; i < timedSegments.length; i++) {
        await send({
          type: "progress",
          message: `Generating scene image ${i + 1} of ${timedSegments.length}…`,
          elapsedSecs: elapsed(),
        });
        try {
          const buf = await generateSceneImage(timedSegments[i].imagePrompt);
          imageBuffers.push(buf);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[generate-video] Scene image ${i + 1} failed: ${errMsg}`);
          await send({ type: "progress", message: `Scene ${i + 1} image failed (${errMsg}) — using placeholder`, elapsedSecs: elapsed() });
          imageBuffers.push(null);
        }
      }

      // ── 3. Upload images to WP media — sequential with delay ─────
      const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

      const imageUrls: string[] = [];
      for (let i = 0; i < imageBuffers.length; i++) {
        const buf = imageBuffers[i];
        await send({
          type: "progress",
          message: `Uploading scene image ${i + 1} of ${imageBuffers.length}…`,
          elapsedSecs: elapsed(),
        });
        if (!buf) {
          imageUrls.push(FALLBACK_IMG);
          continue;
        }
        try {
          // Upload to Remotion S3 (same AWS region as Lambda renderer).
          // Lambda fetches these in ~10ms vs 200–500ms from WordPress/SiteGround
          // which was causing the 300s render timeout.
          const url = await uploadSceneImageToS3(buf, `${slug}-scene-${i + 1}.png`);
          imageUrls.push(url);
        } catch (err) {
          console.warn(`[generate-video] Image ${i + 1} S3 upload failed: ${err instanceof Error ? err.message : err}`);
          imageUrls.push(FALLBACK_IMG);
        }
      }
      const uploaded = imageUrls.filter(u => u !== FALLBACK_IMG).length;
      console.log(`[generate-video] Uploaded ${uploaded}/${imageBuffers.length} images (${imageBuffers.length - uploaded} used fallback)`);

      // ── 4. Generate narration audio ──────────────────────────────
      let audioUrl = providedAudioUrl?.trim() || "";
      let audioDurationSeconds = 0;

      if (!audioUrl) {
        await send({ type: "progress", message: "Generating narration audio (this takes ~1–2 min)…", elapsedSecs: elapsed() });
        const script = hasContent && scriptFields
          ? articleToAudioScript(title.trim(), scriptFields)
          : timedSegments.map((s) => s.narration).join(" ");

        // Wrap Kokoro in a 150 s deadline — if it hangs we fail fast with
        // a clear error rather than silently hitting Vercel's 300 s limit.
        const audioResult = await Promise.race([
          generateKokoroSpeech(script),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Audio generation timed out after 150 s. Try using an existing audio file.")), 150_000)
          ),
        ]);
        audioDurationSeconds = estimateMp3DurationSeconds(audioResult.buffer);
        const ext = audioResult.mimeType === "audio/mpeg" ? "mp3" : "wav";
        await send({ type: "progress", message: "Uploading narration audio…", elapsedSecs: elapsed() });
        const { url } = await uploadMediaToWordPress(audioResult.buffer, `${slug}-video-audio.${ext}`, audioResult.mimeType);
        audioUrl = url;
        console.log(`[generate-video] Audio uploaded: ${audioUrl} (~${Math.round(audioDurationSeconds)}s)`);
      } else {
        const totalWords = timedSegments.reduce((s, seg) => s + seg.wordCount, 0);
        audioDurationSeconds = (totalWords / 130) * 60;
        console.log(`[generate-video] Using provided audio, estimated duration: ~${Math.round(audioDurationSeconds)}s`);
      }

      // ── 5. Calibrate every segment duration to the real audio ─────
      // Proportional split: segment_duration = (segment_words / total_words) × audio_duration
      // This guarantees images change exactly when the narration moves to the next scene.
      const calibrated = audioDurationSeconds > 0
        ? calibrateSegmentDurations(timedSegments, audioDurationSeconds)
        : timedSegments;
      const totalDurationSecs = calibrated.reduce((s, seg) => s + seg.durationSeconds, 0);
      console.log(`[generate-video] Scene durations: ${calibrated.map(s => Math.round(s.durationSeconds) + "s").join(", ")}`);

      // ── 6. Submit to Remotion Lambda for rendering ───────────────
      await send({ type: "progress", message: "Submitting to Remotion Lambda for rendering…", elapsedSecs: elapsed() });

      const videoSegments: VideoSegment[] = calibrated.map((seg, i) => ({
        sectionTitle:    seg.sectionTitle,
        displayText:     seg.displayText,
        bullets:         seg.bullets ?? [],
        durationSeconds: seg.durationSeconds,
        imageUrl:        imageUrls[i],
      }));

      const { renderId, bucketName } = await submitRemotionRender({
        segments: videoSegments,
        audioUrl,
        logoUrl:  logoS3Url,
        musicUrl: process.env.BACKGROUND_MUSIC_URL ?? "",
        outName: `${slug}-video.mp4`,
      });
      console.log(`[generate-video] Remotion render submitted: ${renderId} (bucket: ${bucketName})`);

      // Build YouTube chapter markers from calibrated scene start times
      let chapterOffset = 0;
      const chapters = calibrated.map((seg) => {
        const chapter = { title: seg.sectionTitle, startSecs: Math.round(chapterOffset) };
        chapterOffset += seg.durationSeconds;
        return chapter;
      });

      await send({
        type:         "submitted",
        renderId,
        bucketName,
        totalDurationSecs,
        sceneCount:   calibrated.length,
        chapters,
        elapsedSecs:  elapsed(),
        message:      `Rendering ${calibrated.length} scenes (~${Math.round(totalDurationSecs / 60)} min video)…`,
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
