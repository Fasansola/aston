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

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content: `You write short video prompts for Google Veo 2, a text-to-video AI model.
Rules:
- 2–3 sentences max, purely visual description
- Include camera movement, lighting mood, and setting
- Professional / corporate / business aesthetic
- No text, logos, signs, or readable words in scene
- No specific people — use silhouettes, hands, or abstract business settings
- Cinematic quality, 16:9 aspect ratio
${langNote}`,
      },
      {
        role: "user",
        content: `Write a Veo 2 video prompt for a blog article titled: "${title}"\nFocus keyword: "${keyword}"`,
      },
    ],
  }, { signal: AbortSignal.timeout(30_000) });

  return choices[0].message.content?.trim() ?? `Cinematic aerial view of a modern business district at golden hour, slow pan across glass skyscrapers, professional and aspirational mood.`;
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

  console.log("[video] videoBytes present:", !!videoObj.videoBytes, "| uri present:", !!videoObj.uri);

  // Gemini API returns base64-encoded bytes; Vertex AI returns a GCS URI
  if (videoObj.videoBytes) {
    return Buffer.from(videoObj.videoBytes, "base64");
  }
  if (videoObj.uri) {
    const res = await fetch(videoObj.uri);
    if (!res.ok) throw new Error(`Failed to fetch video from URI: ${res.status}`);
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
 * Uploads a video Buffer to YouTube.
 * Returns the full YouTube watch URL.
 */
export async function uploadToYouTube(
  videoBuffer: Buffer,
  title: string,
  description: string
): Promise<string> {
  const yt = youtubeClient();
  const videoStream = Readable.from(videoBuffer);

  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description,
        categoryId: "22", // People & Blogs
        tags: ["business", "UAE", "Aston"],
      },
      status: {
        privacyStatus: "unlisted", // accessible via link but not searchable
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

// ── 4. WordPress patch ────────────────────────────────────────────────────────

/**
 * Patches the WP post's ACF `video_url` field with the YouTube URL.
 * Requires a `video_url` ACF field to be registered on the post type in WordPress.
 */
export async function updatePostVideoUrl(
  postId: number,
  youtubeUrl: string
): Promise<void> {
  await axios.post(
    `${WP_URL}/wp-json/wp/v2/posts/${postId}`,
    { acf: { video_url: youtubeUrl } },
    { headers: BASE_HEADERS, timeout: 15_000 }
  );
}
