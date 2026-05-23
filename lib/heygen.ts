/**
 * lib/heygen.ts
 * ─────────────────────────────────────────────────────────────
 * HeyGen avatar video generation pipeline:
 *   1. generateVideoScript()   — GPT-4o writes a 3-minute spoken script
 *   2. createHeyGenVideo()     — submits script to HeyGen API, returns video_id
 *   3. pollHeyGenVideo()       — polls until completed, returns MP4 URL
 *
 * Required env vars:
 *   HEYGEN_API_KEY             — from HeyGen dashboard → Settings → API
 *   HEYGEN_AVATAR_ID           — avatar look ID (e.g. Leos_sitting_office_front)
 *   HEYGEN_AVATAR_GROUP_ID     — avatar group ID
 *   HEYGEN_VOICE_ID            — voice ID for narration
 */

import OpenAI from "openai";

const HEYGEN_BASE = "https://api.heygen.com";

function heygenHeaders() {
  return {
    "X-Api-Key": process.env.HEYGEN_API_KEY!,
    "Content-Type": "application/json",
  };
}

// ── 1. Script generation ──────────────────────────────────────────────────────

/**
 * Uses GPT-4o to write a ~3-minute spoken script (≈ 420–450 words)
 * suitable for a professional HeyGen avatar video.
 */
export async function generateVideoScript(
  title: string,
  keyword: string,
  language?: string
): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const langNote = language && language !== "en"
    ? `The article targets a ${language}-speaking audience. Write the script in ${language}.`
    : "";

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: `You write professional 3-minute video scripts for a business avatar presenter.

RULES:
- Exactly 420–450 words (spoken at ~150 wpm = ~3 minutes)
- Natural, conversational, spoken English — no bullet points, no markdown, no headers
- Open with a compelling hook question or statement (first 2 sentences grab attention)
- Body: 3–4 key insights from the article topic
- Close with a clear call to action directing viewers to Aston VIP's website
- Tone: authoritative, warm, professional — suitable for Dubai/UAE financial & real estate audience
- No filler phrases like "In this video we will..." or "As I mentioned..."
- Write only the script text — no stage directions, no [pause], no speaker labels
${langNote}`,
      },
      {
        role: "user",
        content: `Write a 3-minute video script for an article titled: "${title}"\nFocus keyword: "${keyword}"`,
      },
    ],
  }, { signal: AbortSignal.timeout(30_000) });

  const script = choices[0].message.content?.trim() ?? "";
  if (!script) throw new Error("GPT returned an empty script.");
  console.log(`[heygen] Script generated (${script.split(/\s+/).length} words)`);
  return script;
}

// ── 2. Create HeyGen video ────────────────────────────────────────────────────

/**
 * Submits a script to HeyGen and returns the video_id.
 * Uses the avatar and voice configured in env vars.
 */
export async function createHeyGenVideo(
  script: string,
  title?: string
): Promise<string> {
  const avatarId = process.env.HEYGEN_AVATAR_ID!;
  const voiceId  = process.env.HEYGEN_VOICE_ID!;

  const body = {
    title: title?.slice(0, 100) ?? "Aston VIP Video",
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: avatarId,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: script,
          voice_id: voiceId,
          speed: 1.05,
        },
        background: {
          type: "color",
          value: "#f8f8f8",
        },
      },
    ],
    dimension: { width: 1280, height: 720 },
    aspect_ratio: "16:9",
    caption: false,
    test: false,
  };

  const res = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
    method: "POST",
    headers: heygenHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const json = await res.json() as { error?: string | null; data?: { video_id?: string } };

  if (!res.ok || json.error) {
    throw new Error(`HeyGen video creation failed: ${json.error ?? res.statusText}`);
  }

  const videoId = json.data?.video_id;
  if (!videoId) throw new Error("HeyGen returned no video_id.");

  console.log(`[heygen] Video submitted — video_id: ${videoId}`);
  return videoId;
}

// ── 3. Poll until complete ────────────────────────────────────────────────────

type HeyGenStatus = "pending" | "processing" | "waiting" | "completed" | "failed";

interface HeyGenStatusResponse {
  code: number;
  message: string;
  data: {
    status: HeyGenStatus;
    video_url?: string | null;
    thumbnail_url?: string | null;
    duration?: number | null;
    error?: string | null;
  };
}

/**
 * Polls HeyGen until the video is ready (or fails).
 * Returns the MP4 download URL.
 * Calls onProgress with status messages throughout.
 */
export async function pollHeyGenVideo(
  videoId: string,
  onProgress: (msg: string) => void,
  deadlineMs = 600_000 // 10 minutes
): Promise<{ videoUrl: string; duration: number }> {
  const deadline = Date.now() + deadlineMs;
  let pollCount = 0;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error("HeyGen video rendering timed out after 10 minutes.");
    }

    const res = await fetch(
      `${HEYGEN_BASE}/v1/video_status.get?video_id=${videoId}`,
      { headers: heygenHeaders(), signal: AbortSignal.timeout(15_000) }
    );

    const json = await res.json() as HeyGenStatusResponse;
    const { status, video_url, duration, error } = json.data ?? {};

    console.log(`[heygen] Poll #${pollCount + 1} — status: ${status}`);

    if (status === "completed" && video_url) {
      console.log(`[heygen] Completed. Duration: ${duration}s | URL: ${video_url.slice(0, 80)}…`);
      return { videoUrl: video_url, duration: duration ?? 0 };
    }

    if (status === "failed") {
      throw new Error(`HeyGen rendering failed: ${error ?? "unknown reason"}`);
    }

    // Still processing — wait and update progress
    const elapsed = Math.round((Date.now() - (deadline - deadlineMs)) / 1000);
    const waitSecs = pollCount < 4 ? 15 : 20;

    if (status === "processing") {
      onProgress(`Rendering avatar video… (${elapsed}s elapsed)`);
    } else {
      onProgress(`Waiting in queue… (${elapsed}s elapsed)`);
    }

    await new Promise((r) => setTimeout(r, waitSecs * 1000));
    pollCount++;
  }
}
