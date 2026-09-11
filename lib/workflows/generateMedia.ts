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

import { sleep, getWritable, FatalError } from "workflow";
import { isNonRetryableMessage, humaniseError } from "@/lib/errors";
import type { ImagePrompts } from "@/lib/wordpress";
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
  // The text that sits beside each article image on the page (pull-out
  // sentences, closing quote, key takeaways). Optional: older callers omit
  // them and the image briefs fall back to the surrounding sections.
  keypoint_one?:  string;
  keypoint_two?:  string;
  quote_1?:       string;
  quote_2?:       string;
  key_takeaways?: string;
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
  // `images` is optional: only the /media page requests it (posts whose image
  // phase failed) — scheduled posts generate images in their own pipeline.
  outputs: { audio: boolean; video: boolean; podcast: boolean; images?: boolean };
  podcastLength: number;      // minutes: 3 | 15 | 30 | 45 | 60
  // Image briefs already written (and QA'd) by the generation run. When
  // present, imagesStep renders exactly these instead of briefing again, so
  // the pictures match the alt text the article was checked with and the
  // concepts recorded in history are the ones on the page.
  imagePrompts?: ImagePrompts;
  // Queue item this media belongs to, when it came from a scheduled run. The
  // workflow reports per-output progress onto it so the dashboard can show
  // that media is still running after the article itself is complete.
  queueItemId?: string;
}

type MediaDone = { audio: boolean; images: boolean; video: boolean; podcast: boolean };

/** Best-effort progress write onto the queue item — never fails the run. */
async function itemMediaStep(
  queueItemId: string,
  patch: { mediaStatus?: "running" | "done" | "partial" | "failed"; mediaDone?: MediaDone }
): Promise<void> {
  "use step";
  try {
    const { updateQueueItem } = await import("@/lib/storage");
    await updateQueueItem(queueItemId, patch);
  } catch (err) {
    console.warn(`[generateMedia] could not update queue item ${queueItemId}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    throw routeError(label, `route returned ${res.status} — ${err.slice(0, 300)}`);
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
        throw routeError(label, String(event.message ?? "generation failed"));
      }
      if (event.type && terminalTypes.includes(event.type)) {
        return event;
      }
    }
  }
  throw new Error(`${label}: stream ended without a terminal event (last progress: "${lastProgress}")`);
}

// A route relays the underlying failure text. When that text describes a
// permanent OpenAI problem (no credits, bad key, unknown model…) retrying the
// step three more times is pointless, so surface it as a FatalError and let
// the workflow record the failure and move to the next output.
function routeError(label: string, message: string): Error {
  const full = `${label}: ${message}`;
  return isNonRetryableMessage(message) ? new FatalError(full) : new Error(full);
}

// ── Durable steps ─────────────────────────────────────────────

// Alert on output failure — headless runs have no one watching the stream.
async function notifyStep(subject: string, body: string): Promise<void> {
  "use step";
  const { notify } = await import("@/lib/notify");
  await notify(subject, body);
}

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

// Always voices the 3–4 minute scene script. The full-article read-aloud
// audio must NOT be reused here: the scenes are a summary, so stretching them
// across a 20+ minute article narration produced hour-of-scenes videos whose
// burned-in captions and chapters didn't match the spoken audio at all.
async function videoAudioStep(
  segments: TimedVideoSegment[], slug: string
): Promise<{ audioUrl: string; durationSeconds: number }> {
  "use step";
  const { generateNarrationAsset } = await import("@/lib/videoAssets");
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
async function submitVideoDurably(input: GenerateMediaInput): Promise<VideoSubmission> {
  const slug = slugify(input.title);
  const segments = await videoSegmentStep(input);

  // Batches of 3 concurrent image steps (matching the browser route's
  // concurrency) — cuts ~7 sequential generations to ~3 batch waits while
  // each image stays its own checkpoint.
  const IMAGE_CONCURRENCY = 3;
  const imageUrls: string[] = new Array(segments.length).fill(FALLBACK_IMG);
  for (let batch = 0; batch < segments.length; batch += IMAGE_CONCURRENCY) {
    const indexes = Array.from(
      { length: Math.min(IMAGE_CONCURRENCY, segments.length - batch) },
      (_, k) => batch + k
    );
    const results = await Promise.all(indexes.map((i) =>
      videoImageStep(segments[i].imagePrompt, segments[i].sectionTitle, slug, i)
    ));
    indexes.forEach((i, k) => { imageUrls[i] = results[k]; });
  }

  const { logoS3Url, musicS3Url } = await videoAssetsStep();
  const audio = await videoAudioStep(segments, slug);

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

// Generate the four article images (kp1, kp2, split, featured) for a post and
// drive the production /api/generate-images route (generation + WP upload +
// attach). Uses the briefs the generation run already wrote when they were
// passed in; otherwise (Add media page) briefs afresh from the post's own
// text, including the pull-out sentences and quote that sit beside each image.
async function imagesStep(input: GenerateMediaInput): Promise<void> {
  "use step";
  console.log(`[generateMedia] Generating article images for post ${input.postId}…`);
  const { getSettings, updatePostHistory } = await import("@/lib/storage");
  const { conceptsFromPrompts } = await import("@/lib/imageBrief");

  let imagePrompts: ImagePrompts;
  if (input.imagePrompts?.featured_img_prompt) {
    imagePrompts = input.imagePrompts;
    console.log(`[generateMedia] Using the ${Object.keys(imagePrompts).length}-field image brief from the generation run`);
  } else {
    const { generateImagePrompts } = await import("@/lib/openai");
    const { withUsageContext } = await import("@/lib/usage");
    const { isNonRetryableLlmError } = await import("@/lib/llm");
    const c = input.content;
    try {
      imagePrompts = await withUsageContext({ step: "media:imagePrompts" }, () => generateImagePrompts(input.title, {
        focus_keyword:      input.focusKeyword || input.title,
        secondary_keywords: input.secondaryKeywords,
        key_takeaways:      c.key_takeaways,
        main_content:       c.main_content,
        keypoint_one:       c.keypoint_one,
        more_content_1:     c.more_content_1,
        more_content_2:     c.more_content_2,
        quote_1:            c.quote_1,
        more_content_3:     c.more_content_3,
        keypoint_two:       c.keypoint_two,
        more_content_4:     c.more_content_4,
        quote_2:            c.quote_2,
        more_content_5:     c.more_content_5,
        more_content_6:     c.more_content_6,
        final_points:       c.final_points,
      }));
    } catch (err) {
      if (isNonRetryableLlmError(err)) throw new FatalError(err.message);
      throw err;
    }
  }

  // Record what each picture was briefed to show on the Recent posts row.
  // Best-effort: the post may not be in history (older posts, manual URLs).
  try {
    const imageConcepts = conceptsFromPrompts(imagePrompts);
    if (imageConcepts) await updatePostHistory(input.postId, { imageConcepts });
  } catch (err) {
    console.warn(`[generateMedia] could not record image concepts for post ${input.postId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const settings = await getSettings();

  const event = await callSseRoute("/api/generate-images", {
    postId:      input.postId,
    fileSlug:    slugify(input.title),
    imageModel:  settings.imageModel ?? "gpt-image-2",
    imagePrompts,
  }, ["done"], "images");
  console.log(`[generateMedia] Images attached for post ${input.postId}: ${JSON.stringify(event.imageIds ?? {})}`);
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

// Poll the Remotion render every 30s. The cap scales with the video's length
// (a floor of ~20 minutes, plus ~4x realtime for longer videos) so a slow but
// healthy render isn't abandoned — and its Lambda spend wasted — at a fixed
// cutoff.
const VIDEO_POLL_INTERVAL_SECS = 30;
function videoPollMax(totalDurationSecs: number): number {
  const budgetSecs = Math.max(1200, Math.round(totalDurationSecs * 4) + 300);
  return Math.ceil(budgetSecs / VIDEO_POLL_INTERVAL_SECS);
}

export async function generateMediaWorkflow(input: GenerateMediaInput): Promise<GenerateMediaResult> {
  "use workflow";

  const result: GenerateMediaResult = { audioUrl: null, youtubeUrl: null, podcastUrl: null, errors: [] };
  const fail = async (label: string, err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err);
    const msg = `${label}: ${raw}`;
    console.error(`[generateMedia] ${msg}`);
    result.errors.push(msg);
    await emit({ type: "media_failed", output: label, message: raw });
    // humaniseError is a pure function, so it is safe to call in the workflow body.
    const human = humaniseError(raw);
    await notifyStep(
      `⚠️ ${label} generation failed for post ${input.postId}`,
      `"${input.title}"\n${human.title}\n→ ${human.action}\n\nDetails: ${raw.slice(0, 500)}\nRetry from /media?postId=${input.postId}.`
    );
  };

  await emit({ type: "progress", message: "Starting media generation…" });

  // Per-output progress, mirrored onto the queue item so "completed" on the
  // dashboard never hides renders that are still running.
  const done: MediaDone = { audio: false, images: false, video: false, podcast: false };
  const reportMedia = async (status: "running" | "done" | "partial" | "failed") => {
    if (input.queueItemId) await itemMediaStep(input.queueItemId, { mediaStatus: status, mediaDone: done });
  };
  await reportMedia("running");

  // 1 — Read-aloud audio (blog player only — the video voices its own script)
  if (input.outputs.audio) {
    await emit({ type: "progress", output: "audio", message: "Generating read-aloud audio…" });
    try {
      result.audioUrl = await audioStep(input);
      done.audio = true;
      await reportMedia("running");
      await emit({ type: "media_done", output: "audio", url: result.audioUrl });
    } catch (err) {
      await fail("audio", err);
    }
  }

  // 1b — Article images (kp1, kp2, split, featured) for posts missing them.
  // A SiteGround anti-bot block on the upload/attach usually clears within
  // minutes: wait it out durably and try again (bounded, since each attempt
  // regenerates four images) instead of leaving the post without pictures.
  if (input.outputs.images === true) {
    await emit({ type: "progress", output: "images", message: "Writing image prompts and generating 4 article images…" });
    const waits = ["5m", "10m"] as const;
    for (let i = 0; ; i++) {
      try {
        await imagesStep(input);
        done.images = true;
        await reportMedia("running");
        await emit({ type: "media_done", output: "images", url: input.blogUrl ?? "" });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (humaniseError(msg).kind === "wordpress_blocked" && i < waits.length) {
          console.warn(`[generateMedia] images blocked by SiteGround — waiting ${waits[i]} before retry ${i + 1}/${waits.length}`);
          await emit({ type: "progress", output: "images", message: `WordPress is blocking Vercel (SiteGround anti-bot); trying the images again in ${waits[i].replace("m", " min")} (${i + 1} of ${waits.length})` });
          await sleep(waits[i]);
          continue;
        }
        await fail("images", err);
        break;
      }
    }
  }

  // 2 — Video: submit render, then poll with durable sleeps, then upload
  if (input.outputs.video) {
    try {
      await emit({ type: "progress", output: "video", message: "Building scenes and submitting the video render…" });
      // Durable pre-render: segment → 7 image steps → assets → audio → submit,
      // each checkpointed so an overrun resumes instead of regenerating.
      const submission = await submitVideoDurably(input);
      await emit({ type: "progress", output: "video", message: "Rendering video on Remotion Lambda… (this can take a few minutes)" });
      const pollMax = videoPollMax(submission.totalDurationSecs);
      let videoUrl: string | null = null;
      for (let i = 0; i < pollMax; i++) {
        await sleep(`${VIDEO_POLL_INTERVAL_SECS}s`);
        const check = await checkRenderStep(submission.renderId, submission.bucketName);
        if (check.status === "done" && check.url) { videoUrl = check.url; break; }
        if (check.status === "error") throw new Error(`render failed: ${check.error ?? "unknown"}`);
      }
      if (!videoUrl) throw new Error(`render did not finish within ${pollMax} polls (${Math.round(pollMax * VIDEO_POLL_INTERVAL_SECS / 60)} min)`);
      await emit({ type: "progress", output: "video", message: "Uploading the finished video to YouTube…" });
      result.youtubeUrl = await uploadVideoStep(input, videoUrl, submission);
      done.video = true;
      await reportMedia("running");
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
      done.podcast = true;
      await reportMedia("running");
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
  // Final state: everything asked for delivered, some of it, or none.
  const wanted = [
    ["audio", input.outputs.audio], ["images", input.outputs.images === true],
    ["video", input.outputs.video], ["podcast", input.outputs.podcast],
  ] as const;
  const asked = wanted.filter(([, want]) => want);
  const delivered = asked.filter(([key]) => done[key as keyof MediaDone]);
  await reportMedia(delivered.length === asked.length ? "done" : delivered.length > 0 ? "partial" : "failed");

  await emit({ type: "done", result });
  return result;
}
