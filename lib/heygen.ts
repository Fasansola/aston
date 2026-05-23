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
 * Uses GPT-4o to write a natural 3–4 minute spoken script (≈ 540–600 words)
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
    temperature: 0.75,
    max_tokens: 950,
    messages: [
      {
        role: "system",
        content: `You write professional video scripts for a business avatar presenter at Aston VIP — a premium real estate and investment firm based in Dubai.

TARGET LENGTH: 540–600 words (spoken at ~140–150 wpm = 3.5–4 minutes).

TONE & STYLE — this is the most important part:
- Write exactly like a real, confident human would speak — not like a brochure
- Use contractions naturally: "you're", "it's", "here's", "that's", "we've", "don't"
- Vary sentence length deliberately — short punchy lines after longer flowing ones create rhythm
- Use natural spoken connectives: "Now,", "And here's the thing —", "But here's what most people miss.", "So what does that mean for you?", "Think about it.", "And honestly,", "The bottom line is simple."
- Number points as "Number one… Number two… Number three…" — never "Firstly / Secondly"
- Open with a hook that sparks curiosity or speaks to a pain point — not a generic statement
- Each paragraph = one thought. Short paragraphs breathe better when spoken aloud.
- Close with a warm, direct call to action to visit Aston VIP

HARD RULES:
- No bullet points, no markdown, no headers, no stage directions, no [pause] markers
- No filler openers like "In today's video…", "Welcome back…", "As I mentioned…"
- No passive voice — keep it active and direct
- Write only the spoken words — nothing else
${langNote}`,
      },
      {
        role: "user",
        content: `Write a 3–4 minute video script for an article titled: "${title}"\nFocus keyword: "${keyword}"\n\nMake it sound like a real person speaking — warm, authoritative, natural. Not a corporate read.`,
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

  const json = await res.json() as { error?: unknown; data?: { video_id?: string } };

  console.log(`[heygen] Create response (${res.status}):`, JSON.stringify(json));

  if (!res.ok || json.error) {
    const errMsg = typeof json.error === "string"
      ? json.error
      : JSON.stringify(json.error ?? { status: res.status, statusText: res.statusText });
    throw new Error(`HeyGen video creation failed: ${errMsg}`);
  }

  const videoId = json.data?.video_id;
  if (!videoId) throw new Error(`HeyGen returned no video_id. Full response: ${JSON.stringify(json)}`);

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
    error?: unknown;
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

    console.log(`[heygen] Poll #${pollCount + 1} — status: ${status} | full:`, JSON.stringify(json));

    if (status === "completed" && video_url) {
      console.log(`[heygen] Completed. Duration: ${duration}s | URL: ${video_url.slice(0, 80)}…`);
      return { videoUrl: video_url, duration: duration ?? 0 };
    }

    if (status === "failed") {
      const errMsg = typeof error === "string"
        ? error
        : JSON.stringify(error ?? "unknown reason");
      throw new Error(`HeyGen rendering failed: ${errMsg}`);
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
