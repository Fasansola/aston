/**
 * lib/workflows/generateMedia.ts
 * ─────────────────────────────────────────────────────────────
 * Durable post-publish media pipeline — gives the SCHEDULER the same media
 * capabilities as the manual generation page (read-aloud audio, YouTube
 * video, two-voice podcast).
 *
 * On the manual page the BROWSER orchestrates these after publish (fire
 * /api/generate-audio, poll the video render, upload to YouTube…). Scheduled
 * posts have no browser, and the cron function's own budget can't absorb an
 * 800s podcast render. So this workflow drives the SAME production routes
 * server-side as durable steps:
 *
 *   audio   → POST /api/generate-audio        (Kokoro TTS → WP media + ACF)
 *   video   → POST /api/generate-video        (scenes → Remotion render)
 *             GET  /api/check-video-render    (poll, with workflow sleep())
 *             POST /api/upload-video          (YouTube + ACF video_url)
 *   podcast → POST /api/generate-podcast      (dialogue → ElevenLabs → CPT)
 *
 * Each output is independent: one failing never blocks the others. The cron
 * fire-and-forgets this workflow via start() and returns immediately.
 *
 * Routes are called over HTTP with the session cookie (the proxy accepts
 * `__aston_session` = API_SECRET), so the existing, production-proven route
 * logic is reused without refactoring.
 */

import { sleep, getWritable } from "workflow";
// Type-only imports (erased at compile time) — the concrete modules pull in
// Node built-ins (ffmpeg-static, child_process, fs…) which the workflow bundle
// forbids, so the actual functions are dynamically imported INSIDE each step,
// which runs in a normal Node context at runtime.
import type { TimedVideoSegment } from "@/lib/videoScript";
import type { RenderSubmission } from "@/lib/videoAssets";

// Local copies so the workflow body needs no static videoAssets import.
const FALLBACK_IMG = "";
function slugify(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
}

// ── Progress streaming ────────────────────────────────────────
// So a client (the Media page) can follow a media run's live progress the
// same way the main route follows generatePostWorkflow. Must run in a step.
async function emit(event: Record<string, unknown>): Promise<void> {
  "use step";
  const writer = getWritable<string>().getWriter();
  try {
    await writer.write(`data: ${JSON.stringify(event)}\n\n`);
  } finally {
    writer.releaseLock();
  }
}

export interface MediaContentFields {
  main_content:   string;
  more_content_1: string;
  more_content_2: string;
  more_content_3: string;
  more_content_4: string;
  more_content_5: string;
  more_content_6: string;
  final_points:   string;
}

export interface GenerateMediaInput {
  postId: number;
  title: string;
  focusKeyword: string;
  secondaryKeywords: string[];
  summary: string;            // meta description / excerpt — feeds YouTube SEO
  blogUrl: string | null;
  language: string | null;
  content: MediaContentFields;
  outputs: { audio: boolean; video: boolean; podcast: boolean };
  podcastLength: number;      // minutes: 3 | 15 | 30 | 45 | 60
}

// ── HTTP plumbing ─────────────────────────────────────────────

function baseUrl(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // proxy.ts accepts the raw API secret as the session cookie value
    Cookie: `__aston_session=${process.env.API_SECRET}`,
  };
}

type SseEvent = Record<string, unknown> & { type?: string };

/**
 * POST to an SSE route and consume the stream until a terminal event
 * (any type in `terminalTypes`, or "error") arrives. Returns that event.
 */
async function callSseRoute(
  path: string,
  body: Record<string, unknown>,
  terminalTypes: string[],
  label: string
): Promise<SseEvent> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`${label}: route returned ${res.status} — ${err.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastProgress = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data: /, "").trim();
      if (!line) continue;
      let event: SseEvent;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "progress") {
        lastProgress = String(event.message ?? "");
        continue;
      }
      if (event.type === "error") {
        throw new Error(`${label}: ${String(event.message ?? "generation failed")}`);
      }
      if (event.type && terminalTypes.includes(event.type)) {
        return event;
      }
    }
  }
  throw new Error(`${label}: stream ended without a terminal event (last progress: "${lastProgress}")`);
}

// ── Durable steps ─────────────────────────────────────────────

async function audioStep(input: GenerateMediaInput): Promise<string> {
  "use step";
  console.log(`[generateMedia] Generating read-aloud audio for post ${input.postId}…`);
  const event = await callSseRoute("/api/generate-audio", {
    postId: input.postId,
    title:  input.title,
    ...input.content,
  }, ["done"], "audio");
  const audioUrl = String(event.audioUrl ?? "");
  if (!audioUrl) throw new Error("audio: done event carried no audioUrl");
  console.log(`[generateMedia] Audio ready for post ${input.postId}: ${audioUrl}`);
  return audioUrl;
}

type VideoSubmission = RenderSubmission;

// ── Durable video pre-render steps ────────────────────────────
// Each expensive piece is its own "use step" so a timeout/crash resumes from
// the last completed one instead of regenerating everything. All return
// JSON-serializable values (URLs / plain objects — never Buffers).

async function videoSegmentStep(input: GenerateMediaInput): Promise<TimedVideoSegment[]> {
  "use step";
  console.log(`[generateMedia] Segmenting video script for post ${input.postId}…`);
  const { segmentVideoScript } = await import("@/lib/videoScript");
  const c = input.content;
  const hasContent = !!(c.main_content || c.more_content_1 || c.more_content_2);
  const segments = await segmentVideoScript(input.title, hasContent ? c : undefined);
  console.log(`[generateMedia] ${segments.length} scenes segmented for post ${input.postId}`);
  return segments;
}

// One scene image = one checkpoint. Never throws (returns FALLBACK_IMG),
// so a bad image can't fail the run or the render.
async function videoImageStep(prompt: string, sectionTitle: string, slug: string, index: number): Promise<string> {
  "use step";
  console.log(`[generateMedia] Generating scene image ${index + 1} (${sectionTitle})…`);
  const { generateSceneImageUrl } = await import("@/lib/videoAssets");
  return generateSceneImageUrl(prompt, sectionTitle, slug, index);
}

async function videoAssetsStep(): Promise<{ logoS3Url: string; musicS3Url: string }> {
  "use step";
  console.log(`[generateMedia] Preparing logo + music assets…`);
  const { prepareStaticAssets } = await import("@/lib/videoAssets");
  return prepareStaticAssets(process.env.ASTON_LOGO_URL ?? "", process.env.BACKGROUND_MUSIC_URL ?? "");
}

async function videoAudioStep(
  segments: TimedVideoSegment[], slug: string, providedAudioUrl: string | null
): Promise<{ audioUrl: string; durationSeconds: number }> {
  "use step";
  const { generateNarrationAsset, rehostProvidedAudioAsset } = await import("@/lib/videoAssets");
  if (providedAudioUrl) {
    console.log(`[generateMedia] Re-hosting provided narration for video…`);
    const totalWords = segments.reduce((s, seg) => s + seg.wordCount, 0);
    return rehostProvidedAudioAsset(providedAudioUrl, slug, totalWords);
  }
  console.log(`[generateMedia] Generating video narration…`);
  const script = segments.map((s) => s.narration).join(" ");
  return generateNarrationAsset(script, slug);
}

async function videoSubmitRenderStep(params: {
  segments: TimedVideoSegment[]; imageUrls: string[];
  audioUrl: string; audioDurationSeconds: number;
  logoS3Url: string; musicS3Url: string; slug: string;
}): Promise<VideoSubmission> {
  "use step";
  console.log(`[generateMedia] Submitting Remotion render (${params.segments.length} scenes)…`);
  const { buildVideoRenderSubmission } = await import("@/lib/videoAssets");
  const submission = await buildVideoRenderSubmission(params);
  console.log(`[generateMedia] Render submitted: ${submission.renderId}`);
  return submission;
}

/**
 * Orchestrates the durable pre-render: segment → per-image steps → assets →
 * audio → submit. Runs in the workflow body (not a step) so each awaited step
 * is checkpointed individually.
 */
async function submitVideoDurably(input: GenerateMediaInput, reusableAudioUrl: string | null): Promise<VideoSubmission> {
  const slug = slugify(input.title);
  const segments = await videoSegmentStep(input);

  const imageUrls: string[] = new Array(segments.length).fill(FALLBACK_IMG);
  for (let i = 0; i < segments.length; i++) {
    imageUrls[i] = await videoImageStep(segments[i].imagePrompt, segments[i].sectionTitle, slug, i);
  }

  const { logoS3Url, musicS3Url } = await videoAssetsStep();
  const audio = await videoAudioStep(segments, slug, reusableAudioUrl);

  return videoSubmitRenderStep({
    segments, imageUrls, audioUrl: audio.audioUrl, audioDurationSeconds: audio.durationSeconds,
    logoS3Url, musicS3Url, slug,
  });
}

async function checkRenderStep(renderId: string, bucketName: string): Promise<{ status: string; url?: string; error?: string }> {
  "use step";
  const res = await fetch(
    `${baseUrl()}/api/check-video-render?id=${encodeURIComponent(renderId)}&bucket=${encodeURIComponent(bucketName)}`,
    { headers: authHeaders() }
  );
  if (!res.ok) throw new Error(`video poll: route returned ${res.status}`);
  return await res.json() as { status: string; url?: string; error?: string };
}

async function uploadVideoStep(input: GenerateMediaInput, videoUrl: string, submission: VideoSubmission): Promise<string> {
  "use step";
  console.log(`[generateMedia] Uploading rendered video to YouTube for post ${input.postId}…`);
  const res = await fetch(`${baseUrl()}/api/upload-video`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      postId: input.postId,
      title: input.title,
      videoUrl,
      chapters: submission.chapters.length > 0 ? submission.chapters : undefined,
      captionsSrt: submission.captionsSrt || undefined,
      focusKeyword: input.focusKeyword || undefined,
      secondaryKeywords: input.secondaryKeywords.length > 0 ? input.secondaryKeywords : undefined,
      summary: input.summary || undefined,
      blogUrl: input.blogUrl || undefined,
      language: input.language || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`video upload: ${String((data as Record<string, unknown>).error ?? res.statusText)}`);
  const youtubeUrl = String((data as Record<string, unknown>).youtubeUrl ?? "");
  console.log(`[generateMedia] Video uploaded for post ${input.postId}: ${youtubeUrl}`);
  return youtubeUrl;
}

async function podcastStep(input: GenerateMediaInput): Promise<string> {
  "use step";
  console.log(`[generateMedia] Generating ${input.podcastLength}-minute podcast for post ${input.postId}…`);
  const event = await callSseRoute("/api/generate-podcast", {
    postId: input.postId,
    title: input.title,
    focusKeyword: input.focusKeyword,
    length: input.podcastLength,
  }, ["done"], "podcast");
  const url = String(event.audioUrl ?? event.episodeUrl ?? "");
  console.log(`[generateMedia] Podcast ready for post ${input.postId}: ${url}`);
  return url;
}

// ── Workflow ──────────────────────────────────────────────────

export interface GenerateMediaResult {
  audioUrl: string | null;
  youtubeUrl: string | null;
  podcastUrl: string | null;
  errors: string[];
}

// Poll the Remotion render every 30s for up to ~20 minutes.
const VIDEO_POLL_INTERVAL = "30s";
const VIDEO_POLL_MAX = 40;

export async function generateMediaWorkflow(input: GenerateMediaInput): Promise<GenerateMediaResult> {
  "use workflow";

  const result: GenerateMediaResult = { audioUrl: null, youtubeUrl: null, podcastUrl: null, errors: [] };
  const fail = async (label: string, err: unknown) => {
    const msg = `${label}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[generateMedia] ${msg}`);
    result.errors.push(msg);
    await emit({ type: "media_failed", output: label, message: err instanceof Error ? err.message : String(err) });
  };

  await emit({ type: "progress", message: "Starting media generation…" });

  // 1 — Read-aloud audio (also reused as the video narration track)
  if (input.outputs.audio) {
    await emit({ type: "progress", output: "audio", message: "Generating read-aloud audio…" });
    try {
      result.audioUrl = await audioStep(input);
      await emit({ type: "media_done", output: "audio", url: result.audioUrl });
    } catch (err) {
      await fail("audio", err);
    }
  }

  // 2 — Video: submit render, then poll with durable sleeps, then upload
  if (input.outputs.video) {
    try {
      await emit({ type: "progress", output: "video", message: "Building scenes and submitting the video render…" });
      // Durable pre-render: segment → 7 image steps → assets → audio → submit,
      // each checkpointed so an overrun resumes instead of regenerating.
      const submission = await submitVideoDurably(input, result.audioUrl);
      await emit({ type: "progress", output: "video", message: "Rendering video on Remotion Lambda… (this can take a few minutes)" });
      let videoUrl: string | null = null;
      for (let i = 0; i < VIDEO_POLL_MAX; i++) {
        await sleep(VIDEO_POLL_INTERVAL);
        const check = await checkRenderStep(submission.renderId, submission.bucketName);
        if (check.status === "done" && check.url) { videoUrl = check.url; break; }
        if (check.status === "error") throw new Error(`render failed: ${check.error ?? "unknown"}`);
      }
      if (!videoUrl) throw new Error(`render did not finish within ${VIDEO_POLL_MAX} polls`);
      await emit({ type: "progress", output: "video", message: "Uploading the finished video to YouTube…" });
      result.youtubeUrl = await uploadVideoStep(input, videoUrl, submission);
      await emit({ type: "media_done", output: "video", url: result.youtubeUrl });
    } catch (err) {
      await fail("video", err);
    }
  }

  // 3 — Two-voice podcast episode
  if (input.outputs.podcast) {
    await emit({ type: "progress", output: "podcast", message: "Writing and voicing the podcast episode…" });
    try {
      result.podcastUrl = await podcastStep(input);
      await emit({ type: "media_done", output: "podcast", url: result.podcastUrl });
    } catch (err) {
      await fail("podcast", err);
    }
  }

  console.log(
    `[generateMedia] Finished for post ${input.postId} — ` +
    `audio:${result.audioUrl ? "ok" : input.outputs.audio ? "FAILED" : "off"} ` +
    `video:${result.youtubeUrl ? "ok" : input.outputs.video ? "FAILED" : "off"} ` +
    `podcast:${result.podcastUrl ? "ok" : input.outputs.podcast ? "FAILED" : "off"}` +
    (result.errors.length ? ` — errors: ${result.errors.join(" | ")}` : "")
  );
  await emit({ type: "done", result });
  return result;
}
