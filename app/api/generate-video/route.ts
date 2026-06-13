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
import { GoogleGenAI }                                                             from "@google/genai";
import { segmentVideoScript, calibrateSegmentDurations }                          from "@/lib/videoScript";
import { buildSrtFromSegments }                                                   from "@/lib/video";
import { submitRemotionRender }                                                    from "@/lib/remotionRenderer";
import type { VideoSegment }                                                       from "@/src/remotion/VideoComposition";
import { uploadSceneImageToS3, uploadAssetToS3 }                                  from "@/lib/sceneImageS3";
import { uploadMediaToWordPress }                                                  from "@/lib/wordpress";
import { generateKokoroSpeech, estimateMp3DurationSeconds } from "@/lib/replicate";

export const maxDuration = 300;

// Dark navy 1×1 PNG — used when image generation fails so Remotion always has a valid URL.
const FALLBACK_IMG = "https://placehold.co/1280x720/0f1a2e/0f1a2e.png";

async function callImagen(prompt: string): Promise<Buffer> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const response = await ai.models.generateImages({
    model:  "imagen-4.0-generate-001",
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio:    "16:9",
      outputMimeType: "image/jpeg",
    },
  });
  const imgBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imgBytes) throw new Error("Imagen 4 returned no image bytes");
  return Buffer.from(imgBytes, "base64");
}

/**
 * Generates a scene image with up to 3 attempts, each using a simpler prompt
 * if the previous one was blocked by Imagen 4's safety filter.
 *
 * Attempt 1 — full photography brief (the GPT-generated prompt)
 * Attempt 2 — strip camera/lens specs; keep subject + location + lighting
 * Attempt 3 — generic business scene based on the section title
 */
async function generateSceneImage(prompt: string, sectionTitle?: string): Promise<Buffer> {
  // Strip camera/lens specs for a simpler fallback — keeps subject and location
  const simplePrompt = prompt
    .replace(/shot on [^,.]*/gi, "")
    .replace(/\b(f\/[\d.]+|[\d]+mm|shallow depth of field|wide angle|telephoto)\b/gi, "")
    .replace(/,\s*,/g, ",")
    .trim();

  // Generic prompt as last resort — avoids any potentially filtered content
  const genericPrompt = sectionTitle
    ? `A photograph of a modern professional business environment related to ${sectionTitle}, clean office setting in Dubai, natural daylight, warm neutral tones`
    : "A photograph of a sleek modern glass office building in Dubai financial district, blue sky, warm afternoon light, professional corporate setting";

  const attempts = [
    { label: "full prompt",    prompt: prompt },
    { label: "simple prompt",  prompt: simplePrompt },
    { label: "generic prompt", prompt: genericPrompt },
  ];

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      console.log(`[generate-video] Image attempt (${attempt.label})`);
      const buf = await callImagen(attempt.prompt);
      return buf;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[generate-video] Image ${attempt.label} failed: ${lastError.message}`);
      // Brief pause before retrying so we don't hammer the API
      await new Promise(r => setTimeout(r, 2_000));
    }
  }

  throw lastError ?? new Error("All image generation attempts failed");
}

// Fetches an asset from its source URL and re-uploads to S3 so Lambda can
// load it reliably (SiteGround blocks many AWS IP ranges).
async function fetchAssetToS3(
  sourceUrl: string,
  s3Filename: string,
  fallbackContentType: string
): Promise<string> {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Asset fetch failed: ${res.status}`);
    const buf         = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? fallbackContentType;
    return await uploadAssetToS3(buf, s3Filename, contentType);
  } catch (err) {
    console.warn(`[generate-video] S3 upload failed for ${s3Filename}, using original URL: ${err instanceof Error ? err.message : err}`);
    return sourceUrl;
  }
}

async function fetchLogoToS3(logoUrl: string): Promise<string> {
  const ext = logoUrl.endsWith(".svg") ? "svg" : "png";
  return fetchAssetToS3(logoUrl, `aston-logo.${ext}`, "image/svg+xml");
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

      // ── 0. Upload static assets to S3 so Lambda can load them reliably ──
      // SiteGround blocks AWS Lambda IP ranges, so any WordPress-hosted file
      // must be re-hosted on S3 (same region as Lambda) before rendering.
      const rawMusicUrl = process.env.BACKGROUND_MUSIC_URL ?? "";
      const [logoS3Url, musicS3Url] = await Promise.all([
        fetchLogoToS3(logoUrl),
        rawMusicUrl ? fetchAssetToS3(rawMusicUrl, "background-music.mp3", "audio/mpeg") : Promise.resolve(""),
      ]);

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
          const buf = await generateSceneImage(timedSegments[i].imagePrompt, timedSegments[i].sectionTitle);
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
      // NOTE: audio is always uploaded to S3 (same region as Lambda) before
      // the render is submitted. SiteGround blocks Lambda's IP ranges, so
      // any WordPress-hosted audio URL would fail during rendering.
      let audioS3Url = "";
      let audioDurationSeconds = 0;

      if (!providedAudioUrl?.trim()) {
        await send({ type: "progress", message: "Generating narration audio (this takes ~1–2 min)…", elapsedSecs: elapsed() });
        // Always narrate from the condensed 3–4 min video script GPT wrote,
        // never from the full article (which could be 20+ minutes of content).
        const script = timedSegments.map((s) => s.narration).join(" ");

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
        const filename = `${slug}-video-audio.${ext}`;

        // Upload to WordPress (for archival / reuse later)
        await send({ type: "progress", message: "Uploading narration audio…", elapsedSecs: elapsed() });
        uploadMediaToWordPress(audioResult.buffer, filename, audioResult.mimeType).catch(err =>
          console.warn(`[generate-video] WordPress audio upload failed (non-fatal): ${err.message}`)
        );

        // Upload to S3 so Lambda can fetch it (SiteGround blocks Lambda IPs)
        audioS3Url = await uploadAssetToS3(audioResult.buffer, filename, audioResult.mimeType, "audio");
        console.log(`[generate-video] Audio uploaded to S3 (~${Math.round(audioDurationSeconds)}s)`);
      } else {
        // Pre-provided URL (WordPress-hosted) — fetch and re-host on S3
        await send({ type: "progress", message: "Copying audio to S3 for rendering…", elapsedSecs: elapsed() });
        const audioFilename = providedAudioUrl.trim().split("/").pop() ?? "video-audio.mp3";
        audioS3Url = await fetchAssetToS3(providedAudioUrl.trim(), audioFilename, "audio/mpeg");
        const totalWords = timedSegments.reduce((s, seg) => s + seg.wordCount, 0);
        audioDurationSeconds = (totalWords / 130) * 60;
        console.log(`[generate-video] Using provided audio via S3, estimated duration: ~${Math.round(audioDurationSeconds)}s`);
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
        audioUrl: audioS3Url,
        logoUrl:  logoS3Url,
        musicUrl: musicS3Url,
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

      // Build an SRT caption track from the same calibrated segments so the text
      // is correctly spelled and timed to the narration (uploaded after the video
      // lands on YouTube — see /api/upload-video). Phase 2 SEO.
      const captionsSrt = buildSrtFromSegments(
        calibrated.map((seg) => ({ text: seg.narration, durationSeconds: seg.durationSeconds }))
      );

      await send({
        type:         "submitted",
        renderId,
        bucketName,
        totalDurationSecs,
        sceneCount:   calibrated.length,
        chapters,
        captionsSrt,
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
