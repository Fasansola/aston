/**
 * lib/videoAssets.ts
 * ─────────────────────────────────────────────────────────────
 * The heavy lifting of the video pre-render phase, extracted so it can be
 * driven two ways:
 *   - the streaming /api/generate-video route (browser-driven, live progress)
 *   - the durable generateMediaWorkflow (each piece a checkpointed "use step",
 *     so a timeout/crash resumes instead of regenerating everything)
 *
 * Every exported function returns JSON-serializable values (URLs / plain
 * objects — never Buffers) so it can be a workflow step boundary.
 */

import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { calibrateSegmentDurations, type TimedVideoSegment } from "./videoScript";
import { buildSrtFromSegments } from "./video";
import { submitRemotionRender } from "./remotionRenderer";
import { uploadSceneImageToS3, uploadAssetToS3 } from "./sceneImageS3";
import { uploadMediaToWordPress } from "./wordpress";
import { generateElevenLabsNarration, measureAudioDurationSeconds } from "./podcastAudio";
import type { VideoSegment } from "@/src/remotion/VideoComposition";

// Empty string → the Remotion composition's SafeImg renders a solid navy fill,
// so a failed scene image never breaks the render (no external fallback URL).
export const FALLBACK_IMG = "";

export function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

// Reject a promise if it doesn't settle within `ms`. Hard-caps external image
// calls whose SDKs don't expose an abort signal (Imagen).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// GPT Image 2 — 1536x1024, 120s cap so a slow image fails over to Imagen fast.
async function callGptImage2(prompt: string): Promise<Buffer> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.images.generate({
    model: "gpt-image-2", prompt, n: 1, size: "1536x1024", quality: "high",
  }, { signal: AbortSignal.timeout(120_000) });
  const b64 = response.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, "base64");
  const url = response.data?.[0]?.url;
  if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("GPT Image 2 returned no image data");
}

// Imagen 4 fallback — no SDK abort option, so hard-capped at 60s.
async function callImagen(prompt: string): Promise<Buffer> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const response = await withTimeout(ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt,
    config: { numberOfImages: 1, aspectRatio: "16:9", outputMimeType: "image/jpeg" },
  }), 60_000, "Imagen 4");
  const imgBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imgBytes) throw new Error("Imagen 4 returned no image bytes");
  return Buffer.from(imgBytes, "base64");
}

/** GPT Image 2 primary → Imagen 4 fallback (full → simple → generic prompt). */
async function generateSceneImageBuffer(prompt: string, sectionTitle?: string): Promise<Buffer> {
  const simplePrompt = prompt
    .replace(/shot on [^,.]*/gi, "")
    .replace(/\b(f\/[\d.]+|[\d]+mm|shallow depth of field|wide angle|telephoto)\b/gi, "")
    .replace(/,\s*,/g, ",")
    .trim();
  const genericPrompt = sectionTitle
    ? `A photograph of a modern professional business environment related to ${sectionTitle}, clean office setting in Dubai, natural daylight, warm neutral tones`
    : "A photograph of a sleek modern glass office building in Dubai financial district, blue sky, warm afternoon light, professional corporate setting";

  try {
    return await callGptImage2(prompt);
  } catch (err) {
    console.warn(`[videoAssets] gpt-image-2 failed: ${err instanceof Error ? err.message : String(err)} — falling back to Imagen 4`);
  }

  const attempts = [
    { label: "imagen full",    prompt },
    { label: "imagen simple",  prompt: simplePrompt },
    { label: "imagen generic", prompt: genericPrompt },
  ];
  let lastError: Error | null = null;
  for (const a of attempts) {
    try {
      return await callImagen(a.prompt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[videoAssets] Image ${a.label} failed: ${lastError.message}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw lastError ?? new Error("All image generation attempts failed");
}

/**
 * Generate ONE scene image and upload it to S3, returning its URL. Never
 * throws — returns FALLBACK_IMG ("") on any failure so the render always has a
 * value and the composition's SafeImg renders a navy fill. This is the unit a
 * workflow checkpoints per image.
 */
export async function generateSceneImageUrl(
  prompt: string, sectionTitle: string, slug: string, index: number
): Promise<string> {
  let buf: Buffer;
  try {
    buf = await generateSceneImageBuffer(prompt, sectionTitle);
  } catch (err) {
    console.warn(`[videoAssets] Scene image ${index + 1} generation failed: ${err instanceof Error ? err.message : err}`);
    return FALLBACK_IMG;
  }
  try {
    return await uploadSceneImageToS3(buf, `${slug}-scene-${index + 1}.png`);
  } catch (err) {
    console.warn(`[videoAssets] Scene image ${index + 1} S3 upload failed: ${err instanceof Error ? err.message : err}`);
    return FALLBACK_IMG;
  }
}

/** Fetch an asset and re-host on S3 (Lambda can't reach SiteGround). */
async function fetchAssetToS3(sourceUrl: string, s3Filename: string, fallbackContentType: string): Promise<string> {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Asset fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return await uploadAssetToS3(buf, s3Filename, res.headers.get("content-type") ?? fallbackContentType);
  } catch (err) {
    console.warn(`[videoAssets] S3 upload failed for ${s3Filename}, using original URL: ${err instanceof Error ? err.message : err}`);
    return sourceUrl;
  }
}

async function fetchLogoToS3(logoUrl: string): Promise<string> {
  if (!logoUrl.toLowerCase().endsWith(".svg")) {
    return fetchAssetToS3(logoUrl, "aston-logo.png", "image/png");
  }
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Logo fetch failed: ${res.status}`);
    const svgBuf = Buffer.from(await res.arrayBuffer());
    const sharp = (await import("sharp")).default;
    const pngBuf = await sharp(svgBuf).png().toBuffer();
    return await uploadAssetToS3(pngBuf, "aston-logo.png", "image/png");
  } catch (err) {
    console.warn(`[videoAssets] SVG→PNG conversion failed, using original URL: ${err instanceof Error ? err.message : err}`);
    return logoUrl;
  }
}

/** Re-host the logo + background music on S3. Returns their URLs. */
export async function prepareStaticAssets(logoUrl: string, musicUrl: string): Promise<{ logoS3Url: string; musicS3Url: string }> {
  const [logoS3Url, musicS3Url] = await Promise.all([
    fetchLogoToS3(logoUrl),
    musicUrl ? fetchAssetToS3(musicUrl, "background-music.mp3", "audio/mpeg") : Promise.resolve(""),
  ]);
  return { logoS3Url, musicS3Url };
}

/** Generate narration from the scene script, measure it, upload to S3 (+ WP archive). */
export async function generateNarrationAsset(script: string, slug: string): Promise<{ audioUrl: string; durationSeconds: number }> {
  const audioResult = await generateElevenLabsNarration(script);
  const durationSeconds = await measureAudioDurationSeconds(audioResult.buffer);
  const ext = audioResult.mimeType === "audio/mpeg" ? "mp3" : "wav";
  const filename = `${slug}-video-audio.${ext}`;
  // Archive to WordPress (non-fatal, fire-and-forget).
  uploadMediaToWordPress(audioResult.buffer, filename, audioResult.mimeType)
    .catch((err) => console.warn(`[videoAssets] WordPress audio upload failed (non-fatal): ${err.message}`));
  const audioUrl = await uploadAssetToS3(audioResult.buffer, filename, audioResult.mimeType, "audio");
  return { audioUrl, durationSeconds };
}

/** Re-host a provided audio URL on S3 and measure its real duration. */
export async function rehostProvidedAudioAsset(
  providedUrl: string, slug: string, fallbackWordCount: number
): Promise<{ audioUrl: string; durationSeconds: number }> {
  const filename = providedUrl.split("/").pop() ?? `${slug}-video-audio.mp3`;
  try {
    const res = await fetch(providedUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`provided audio fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const durationSeconds = await measureAudioDurationSeconds(buf);
    const audioUrl = await uploadAssetToS3(buf, filename, res.headers.get("content-type") ?? "audio/mpeg", "audio");
    return { audioUrl, durationSeconds };
  } catch (err) {
    console.warn(`[videoAssets] Could not fetch provided audio to measure (${err instanceof Error ? err.message : err}) — estimate + URL rehost`);
    const audioUrl = await fetchAssetToS3(providedUrl, filename, "audio/mpeg");
    return { audioUrl, durationSeconds: (fallbackWordCount / 130) * 60 };
  }
}

export interface RenderSubmission {
  renderId: string;
  bucketName: string;
  totalDurationSecs: number;
  sceneCount: number;
  chapters: Array<{ title: string; startSecs: number }>;
  captionsSrt: string;
}

/**
 * Calibrate scene durations to the real audio length, build the segments,
 * submit the Remotion render, and return the render id + YouTube metadata.
 */
export async function buildVideoRenderSubmission(params: {
  segments: TimedVideoSegment[];
  imageUrls: string[];
  audioUrl: string;
  audioDurationSeconds: number;
  logoS3Url: string;
  musicS3Url: string;
  slug: string;
}): Promise<RenderSubmission> {
  const { segments, imageUrls, audioUrl, audioDurationSeconds, logoS3Url, musicS3Url, slug } = params;

  const calibrated = audioDurationSeconds > 0
    ? calibrateSegmentDurations(segments, audioDurationSeconds)
    : segments;
  const totalDurationSecs = calibrated.reduce((s, seg) => s + seg.durationSeconds, 0);

  const videoSegments: VideoSegment[] = calibrated.map((seg, i) => ({
    sectionTitle:    seg.sectionTitle,
    displayText:     seg.displayText,
    bullets:         seg.bullets ?? [],
    durationSeconds: seg.durationSeconds,
    imageUrl:        imageUrls[i] ?? FALLBACK_IMG,
    narration:       seg.narration,
  }));

  const { renderId, bucketName } = await submitRemotionRender({
    segments: videoSegments,
    audioUrl,
    logoUrl:  logoS3Url,
    musicUrl: musicS3Url,
    outName:  `${slug}-video.mp4`,
  });

  let chapterOffset = 0;
  const chapters = calibrated.map((seg) => {
    const chapter = { title: seg.sectionTitle, startSecs: Math.round(chapterOffset) };
    chapterOffset += seg.durationSeconds;
    return chapter;
  });
  const captionsSrt = buildSrtFromSegments(
    calibrated.map((seg) => ({ text: seg.narration ?? "", durationSeconds: seg.durationSeconds }))
  );

  return { renderId, bucketName, totalDurationSecs, sceneCount: calibrated.length, chapters, captionsSrt };
}
