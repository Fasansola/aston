/**
 * lib/video.ts
 * ─────────────────────────────────────────────────────────────
 * Three-step pipeline:
 *   1. generateVideoPrompt()  — GPT writes a cinematic Veo prompt
 *   2. generateVeoVideo()     — Veo 2 generates the clip (polls until done)
 *   3. uploadToYouTube()      — streams clip to YouTube via googleapis
 *   4. updatePostVideoUrl()   — patches the WP post's ACF video_url field
 *
 * Required env vars:
 *   GEMINI_API_KEY            — already used by imagen-4
 *   OPENAI_API_KEY            — already used for content generation
 *   YOUTUBE_CLIENT_ID         — from Google Cloud OAuth 2.0 credentials
 *   YOUTUBE_CLIENT_SECRET     — from Google Cloud OAuth 2.0 credentials
 *   YOUTUBE_REFRESH_TOKEN     — obtained once via scripts/youtube-auth.mjs
 *   WP_URL / WP_USERNAME / WP_APP_PASSWORD — already set
 */

import OpenAI from "openai";
import { google } from "googleapis";
import { Readable } from "stream";
import axios from "axios";
import { axiosWithSgRetry } from "./wordpress";

const WP_URL      = process.env.WP_URL!;
const WP_USERNAME = process.env.WP_USERNAME!;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;
const WP_AUTH = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

const BASE_HEADERS = {
  Authorization: `Basic ${WP_AUTH}`,
  "Content-Type": "application/json",
};

// ── 1. Prompt generation ──────────────────────────────────────────────────────

/**
 * Uses GPT to write a Veo-optimised video prompt for the given article.
 * Keeps it cinematic, business-appropriate, no text/logos.
 */
export async function generateVideoPrompt(
  title: string,
  keyword: string,
  language?: string
): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const langNote = language && language !== "en"
    ? `The article targets a ${language}-speaking audience.`
    : "";

  // gpt-4o: short, fast Veo prompt with a 30s timeout — gpt-5.5 reasoning latency
  // overran it. Mechanical media task, not blog-post content.
  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: `You write short video prompts for Google Veo 2, a text-to-video AI model.
STRICT RULES — violations cause the video to be blocked:
- ZERO humans, people, faces, silhouettes, shadows of people, hands, or any body part
- ZERO text, signs, logos, labels, or readable words anywhere in the scene
- Focus ONLY on: architecture, cityscapes, objects, nature, abstract motion, technology hardware (screens, keyboards), documents, maps, charts
- 2–3 sentences max, purely visual description
- Include camera movement (slow pan, aerial drift, dolly) and lighting mood
- Professional / corporate / business aesthetic, cinematic 16:9
${langNote}`,
      },
      {
        role: "user",
        content: `Write a Veo 2 video prompt for a blog article titled: "${title}"\nFocus keyword: "${keyword}"\n\nRemember: absolutely no people, hands, or silhouettes.`,
      },
    ],
  }, { signal: AbortSignal.timeout(30_000) });

  const prompt = choices[0].message.content?.trim()
    ?? `Cinematic slow aerial drift over a gleaming modern business district at golden hour, glass towers reflecting warm amber light, no people visible, professional and aspirational atmosphere.`;

  console.log(`[video] Generated prompt: ${prompt}`);
  return prompt;
}

// ── 2. Veo 2 video generation ─────────────────────────────────────────────────

/**
 * Generates a short video clip via Veo 2.
 * Polls until the operation is complete (up to `deadlineMs`).
 * Returns the video as a Buffer (Gemini API returns base64 bytes;
 * Vertex AI returns a GCS URI which is fetched and buffered here).
 */
export async function generateVeoVideo(
  prompt: string,
  onProgress: (msg: string) => void,
  deadlineMs = 240_000
): Promise<Buffer> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  onProgress("Submitting video generation request to Veo 2…");

  let operation = await ai.models.generateVideos({
    model: "veo-2.0-generate-001",
    prompt,
    config: {
      numberOfVideos: 1,
      aspectRatio: "16:9",
      durationSeconds: 8,
      resolution: "720p",
      personGeneration: "dont_allow",
      enhancePrompt: true,
      negativePrompt: "people, person, human, face, hands, silhouette, body, crowd, man, woman, text, words, signs, logos",
    },
  });

  const deadline = Date.now() + deadlineMs;
  let pollCount = 0;

  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error("Veo 2 video generation timed out after 4 minutes.");
    }
    const waitSecs = Math.min(15 + pollCount * 5, 30);
    onProgress(`Generating video… (${Math.round((Date.now() - (deadline - deadlineMs)) / 1000)}s elapsed)`);
    await new Promise((r) => setTimeout(r, waitSecs * 1000));
    operation = await ai.operations.getVideosOperation({ operation });
    pollCount++;
  }

  const response = operation.response;
  console.log("[video] Veo operation complete. RAI filtered:", response?.raiMediaFilteredCount ?? 0);
  console.log("[video] RAI reasons:", JSON.stringify(response?.raiMediaFilteredReasons ?? []));
  console.log("[video] Generated videos count:", response?.generatedVideos?.length ?? 0);

  if ((response?.raiMediaFilteredCount ?? 0) > 0) {
    const reasons = response?.raiMediaFilteredReasons?.join(", ") || "unspecified policy";
    throw new Error(`Veo 2 blocked the video due to content policy: ${reasons}. Try generating again with a different post topic.`);
  }

  const videoObj = response?.generatedVideos?.[0]?.video;
  if (!videoObj) {
    console.error("[video] Full operation response:", JSON.stringify(response));
    throw new Error("Veo 2 returned no video data. Check Vercel logs for the full response.");
  }

  console.log("[video] videoBytes present:", !!videoObj.videoBytes, "| uri:", videoObj.uri ?? "none");

  if (videoObj.videoBytes) {
    return Buffer.from(videoObj.videoBytes, "base64");
  }

  if (videoObj.uri) {
    // Google API URIs require the API key — add it as a query param
    const uri = videoObj.uri;
    const fetchUrl = uri.includes("googleapis.com") && !uri.includes("key=")
      ? `${uri}${uri.includes("?") ? "&" : "?"}key=${process.env.GEMINI_API_KEY}`
      : uri;

    console.log("[video] Fetching video from URI (domain):", new URL(fetchUrl).hostname);
    const res = await fetch(fetchUrl);
    if (!res.ok) {
      console.error("[video] URI fetch failed:", res.status, res.statusText);
      throw new Error(`Failed to fetch video from URI: ${res.status} ${res.statusText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error("Veo 2 response contained neither videoBytes nor uri.");
}

// ── 3. YouTube upload ─────────────────────────────────────────────────────────

function youtubeClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth: oauth2 });
}

/**
 * YouTube limits the total length of all tags combined to ~500 characters
 * (commas count). Dedupe, drop empties, and accumulate until the budget is hit
 * so an oversized tag list can never reject the entire upload.
 */
function sanitizeYouTubeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let budget = 480; // leave headroom under the 500 cap
  for (const raw of tags) {
    const tag = (raw ?? "").replace(/[<>]/g, "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    const cost = tag.length + 1; // +1 approximates the comma separator
    if (budget - cost < 0) break;
    out.push(tag);
    seen.add(key);
    budget -= cost;
  }
  return out;
}

/**
 * Uploads a video Buffer to YouTube.
 * Returns the full YouTube watch URL.
 */
export async function uploadToYouTube(
  videoBuffer: Buffer,
  title: string,
  description: string,
  tags: string[] = ["business", "UAE", "Aston"]
): Promise<string> {
  const yt = youtubeClient();
  const videoStream = Readable.from(videoBuffer);

  // YouTube caps the combined tag length at ~500 chars; trim defensively so a
  // long tag list never rejects the whole upload.
  const safeTags = sanitizeYouTubeTags(tags);

  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description: description.slice(0, 5000),
        categoryId: "22", // People & Blogs
        tags: safeTags,
      },
      status: {
        privacyStatus: "public", // publicly listed and searchable on YouTube
      },
    },
    media: {
      mimeType: "video/mp4",
      body: videoStream,
    },
  });

  const videoId = res.data.id;
  if (!videoId) throw new Error("YouTube upload succeeded but returned no video ID.");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// ── 3b. Captions (SRT) + auto-comment — Phase 2 SEO ───────────────────────────
// Both require the youtube.force-ssl OAuth scope. Callers should treat failures
// as non-fatal so a missing scope (or audit restriction) never breaks the upload.

/** Formats a seconds value as an SRT timestamp: HH:MM:SS,mmm */
function srtTimestamp(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(millis, 3)}`;
}

/**
 * Builds an SRT caption file from the rendered video's segments. Pass each
 * segment's FULL spoken narration (not the short on-screen displayText) so the
 * captions cover everything that is said. Each segment's text is split into
 * sentences spread evenly across that segment's time window (segments play
 * back-to-back), so cue timing tracks the narration closely and the text is
 * spelled correctly (unlike YouTube auto-captions).
 */
export function buildSrtFromSegments(
  segments: Array<{ text: string; durationSeconds: number }>
): string {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let offset = 0;
  for (const seg of segments) {
    const start = offset;
    const end = offset + (seg.durationSeconds || 0);
    offset = end;
    const text = (seg.text || "").replace(/\s+/g, " ").trim();
    if (!text || end <= start) continue;
    const sentences = (text.match(/[^.!?]+[.!?]*/g) ?? [text])
      .map((s) => s.trim())
      .filter(Boolean);
    const per = (end - start) / sentences.length;
    sentences.forEach((sentence, i) => {
      cues.push({ start: start + i * per, end: start + (i + 1) * per, text: sentence });
    });
  }
  return cues
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}`)
    .join("\n\n") + "\n";
}

/**
 * Uploads an SRT caption track to a YouTube video. Non-fatal by contract — the
 * caller catches errors. Requires the youtube.force-ssl scope.
 */
export async function uploadCaptions(
  videoId: string,
  srt: string,
  language = "en"
): Promise<void> {
  const yt = youtubeClient();
  const lang = (language || "en").split("-")[0] || "en";
  await yt.captions.insert({
    part: ["snippet"],
    requestBody: {
      snippet: { videoId, language: lang, name: "", isDraft: false },
    },
    media: { mimeType: "application/octet-stream", body: Readable.from(Buffer.from(srt, "utf8")) },
  }, { signal: AbortSignal.timeout(30_000) });
}

/**
 * Posts a top-level comment on a YouTube video (e.g. consultation + guide links).
 * Note: the Data API can post a comment but cannot PIN it — pinning stays manual.
 * Non-fatal by contract. Requires the youtube.force-ssl scope.
 */
export async function postVideoComment(videoId: string, text: string): Promise<void> {
  const yt = youtubeClient();
  await yt.commentThreads.insert({
    part: ["snippet"],
    requestBody: {
      snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } },
    },
  }, { signal: AbortSignal.timeout(30_000) });
}

/**
 * Lists the top-level comments on a video, newest first. Used by the social
 * connector's comment inbox. Returns the top-level comment id (usable as the
 * parent when replying). Requires the youtube.force-ssl scope.
 */
export async function listVideoComments(
  videoId: string,
  max = 50
): Promise<Array<{ id: string; author: string; text: string; createdAt?: string }>> {
  const yt = youtubeClient();
  const res = await yt.commentThreads.list(
    { part: ["snippet"], videoId, maxResults: max, order: "time" },
    { signal: AbortSignal.timeout(30_000) }
  );
  return (res.data.items ?? []).map((item) => {
    const c = item.snippet?.topLevelComment;
    return {
      id: c?.id ?? "",
      author: c?.snippet?.authorDisplayName ?? "YouTube user",
      text: c?.snippet?.textDisplay ?? "",
      createdAt: c?.snippet?.publishedAt ?? undefined,
    };
  });
}

/**
 * Replies to an existing comment (by its top-level comment id). Returns the new
 * reply's id. Requires the youtube.force-ssl scope.
 */
export async function replyToVideoComment(parentCommentId: string, text: string): Promise<string> {
  const yt = youtubeClient();
  const res = await yt.comments.insert(
    { part: ["snippet"], requestBody: { snippet: { parentId: parentCommentId, textOriginal: text } } },
    { signal: AbortSignal.timeout(30_000) }
  );
  return res.data.id ?? "";
}

// ── 4. WordPress patch ────────────────────────────────────────────────────────

/**
 * Patches the WP post's ACF `video_url` field with the YouTube URL.
 * Requires a `video_url` ACF field to be registered on the post type in WordPress.
 *
 * IMPORTANT: the field is stored as the EMBED URL (youtube.com/embed/ID), not the
 * watch URL. WordPress themes drop this value straight into an <iframe src>, and a
 * plain watch URL cannot be framed — YouTube refuses it and serves its cookie /
 * sign-in wall instead, which looks like "log in to Google to view the video".
 * The /embed/ form is the only URL YouTube allows inside an iframe.
 *
 * Captions are now BURNED INTO the video (open captions in the Remotion render),
 * so we do NOT force the YouTube CC track on via cc_load_policy — doing so would
 * show two sets of subtitles at once. The uploaded CC track still exists (off by
 * default) for SEO indexing and auto-translation.
 */
export async function updatePostVideoUrl(
  postId: number,
  youtubeUrl: string
): Promise<void> {
  const videoId = extractYouTubeVideoId(youtubeUrl);
  const embedUrl = videoId
    ? `https://www.youtube.com/embed/${videoId}`
    : youtubeUrl; // fall back to whatever we were given if parsing fails

  await axiosWithSgRetry("updatePostVideoUrl", () =>
    axios.post(
      `${WP_URL}/wp-json/wp/v2/posts/${postId}`,
      { acf: { video_url: embedUrl } },
      { headers: BASE_HEADERS, timeout: 15_000 }
    )
  );
}

export async function updatePostAudioUrl(
  postId: number,
  audioUrl: string
): Promise<void> {
  await axiosWithSgRetry("updatePostAudioUrl", () =>
    axios.post(
      `${WP_URL}/wp-json/wp/v2/posts/${postId}`,
      { acf: { audio_url: audioUrl } },
      { headers: BASE_HEADERS, timeout: 15_000 }
    )
  );
}

// ── 5. YouTube deletion ───────────────────────────────────────────────────────

/**
 * Extracts the YouTube video ID from any common YouTube URL form.
 * Supports:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://www.youtube.com/embed/VIDEO_ID
 *   https://www.youtube.com/shorts/VIDEO_ID
 */
function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) {
      return parsed.pathname.slice(1).split("/")[0] || null;
    }
    // /embed/ID and /shorts/ID forms carry the ID in the path
    const pathMatch = parsed.pathname.match(/\/(?:embed|shorts)\/([^/?#]+)/);
    if (pathMatch) return pathMatch[1];
    // watch?v=ID form
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * Permanently deletes a YouTube video by its watch URL.
 * Silently succeeds if the video is already gone (404).
 * Throws if YouTube credentials are missing or the API call fails.
 */
export async function deleteYouTubeVideo(youtubeUrl: string): Promise<void> {
  const videoId = extractYouTubeVideoId(youtubeUrl);
  if (!videoId) throw new Error(`Cannot extract video ID from URL: ${youtubeUrl}`);

  const yt = youtubeClient();
  try {
    await yt.videos.delete({ id: videoId });
    console.log(`[video] YouTube video ${videoId} deleted`);
  } catch (err: unknown) {
    // 404 means already deleted — treat as success
    const status = (err as { code?: number })?.code ?? (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      console.log(`[video] YouTube video ${videoId} already gone (404) — skipping`);
      return;
    }
    throw err;
  }
}
