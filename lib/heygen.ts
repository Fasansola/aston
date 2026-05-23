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

// ── 2. Upload audio asset to HeyGen ──────────────────────────────────────────

/**
 * Uploads an MP3 Buffer to HeyGen's asset storage.
 * Returns the asset_id for use in video creation.
 */
async function uploadHeyGenAudio(audioBuffer: Buffer): Promise<string> {
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: "audio/mpeg" });
  form.append("file", blob, "narration.mp3");

  const res = await fetch(`${HEYGEN_BASE}/v3/assets`, {
    method: "POST",
    headers: {
      // Do NOT set Content-Type — let fetch set it with the multipart boundary
      "X-Api-Key": process.env.HEYGEN_API_KEY!,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  const json = await res.json() as Record<string, unknown>;
  console.log(`[heygen] Asset upload response (${res.status}):`, JSON.stringify(json));

  if (!res.ok) {
    throw new Error(`HeyGen audio upload failed (${res.status}): ${JSON.stringify(json)}`);
  }

  const data = json.data as Record<string, unknown> | undefined;
  const assetId =
    (data?.asset_id as string | undefined) ??
    (data?.id      as string | undefined) ??
    (json.asset_id as string | undefined);

  if (!assetId) {
    throw new Error(`HeyGen returned no asset_id. Full response: ${JSON.stringify(json)}`);
  }

  console.log(`[heygen] Audio asset uploaded — asset_id: ${assetId}`);
  return assetId;
}

// ── 3. Check Avatar V eligibility ─────────────────────────────────────────────

/**
 * Checks whether the given avatar look supports Avatar V.
 * Falls back to Avatar IV if the check fails or engine is unsupported.
 */
async function checkAvatarVSupport(avatarId: string): Promise<boolean> {
  try {
    const res = await fetch(`${HEYGEN_BASE}/v3/avatars/looks/${avatarId}`, {
      headers: heygenHeaders(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[heygen] Could not check Avatar V eligibility (${res.status}) — falling back to Avatar IV`);
      return false;
    }

    const json = await res.json() as { data?: { supported_api_engines?: string[] } };
    const engines: string[] = json.data?.supported_api_engines ?? [];
    const supports = engines.includes("avatar_v");
    console.log(`[heygen] Avatar ${avatarId} supported engines: [${engines.join(", ")}] | Avatar V: ${supports}`);
    return supports;
  } catch {
    console.warn(`[heygen] Avatar V eligibility check failed — falling back to Avatar IV`);
    return false;
  }
}

// ── 4. Create HeyGen video (v3 API) ───────────────────────────────────────────

/**
 * Uploads audio to HeyGen, then creates a 1080p landscape avatar video.
 * Uses Avatar V if the avatar look supports it, otherwise falls back to Avatar IV.
 * Returns the video_id for polling.
 */
export async function createHeyGenVideo(
  audioBuffer: Buffer,
  title?: string
): Promise<string> {
  const avatarId = process.env.HEYGEN_AVATAR_ID!;

  // Upload the ElevenLabs audio to HeyGen assets
  const assetId = await uploadHeyGenAudio(audioBuffer);

  // Check if this avatar look supports Avatar V
  const supportsAvatarV = await checkAvatarVSupport(avatarId);
  const engine = supportsAvatarV ? { type: "avatar_v" } : { type: "avatar_iv" };

  const body: Record<string, unknown> = {
    type:            "avatar",
    avatar_id:       avatarId,
    audio_asset_id:  assetId,
    aspect_ratio:    "16:9",
    resolution:      "1080p",
    title:           title?.slice(0, 100) ?? "Aston VIP Video",
    engine,
  };

  console.log(`[heygen] Creating v3 video — engine: ${engine.type}, resolution: 1080p, avatar: ${avatarId}`);

  const res = await fetch(`${HEYGEN_BASE}/v3/videos`, {
    method: "POST",
    headers: heygenHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const json = await res.json() as { error?: unknown; data?: { video_id?: string } };
  console.log(`[heygen] Create v3 response (${res.status}):`, JSON.stringify(json));

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

// ── 5. Poll until complete (v3 API) ───────────────────────────────────────────

type HeyGenStatus = "pending" | "processing" | "completed" | "failed";

interface HeyGenV3StatusResponse {
  data: {
    id: string;
    status: HeyGenStatus;
    video_url?: string | null;
    thumbnail_url?: string | null;
    duration?: number | null;
    failure_code?: string | null;
    failure_message?: string | null;
  };
}

/**
 * Polls HeyGen v3 until the video is ready (or fails / times out).
 * Returns the MP4 download URL and duration.
 */
export async function pollHeyGenVideo(
  videoId: string,
  onProgress: (msg: string) => void,
  deadlineMs = 270_000 // 4.5 minutes — within Vercel's 300s limit
): Promise<{ videoUrl: string; duration: number }> {
  const deadline  = Date.now() + deadlineMs;
  let pollCount   = 0;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error("HeyGen video rendering timed out. 1080p Avatar V videos can take 5–8 minutes — please try again.");
    }

    const res = await fetch(`${HEYGEN_BASE}/v3/videos/${videoId}`, {
      headers: heygenHeaders(),
      signal:  AbortSignal.timeout(15_000),
    });

    const json         = await res.json() as HeyGenV3StatusResponse;
    const { status, video_url, duration, failure_message, failure_code } = json.data ?? {};

    console.log(`[heygen] Poll #${pollCount + 1} — status: ${status}`);

    if (status === "completed" && video_url) {
      console.log(`[heygen] Completed — duration: ${duration}s | URL: ${video_url.slice(0, 80)}…`);
      return { videoUrl: video_url, duration: duration ?? 0 };
    }

    if (status === "failed") {
      const errMsg = failure_message ?? failure_code ?? "unknown reason";
      throw new Error(`HeyGen rendering failed: ${errMsg}`);
    }

    const elapsed   = Math.round((Date.now() - (deadline - deadlineMs)) / 1000);
    const waitSecs  = pollCount < 4 ? 15 : 20;

    onProgress(
      status === "processing"
        ? `Rendering 1080p avatar video… (${elapsed}s elapsed)`
        : `In queue… (${elapsed}s elapsed)`
    );

    await new Promise((r) => setTimeout(r, waitSecs * 1000));
    pollCount++;
  }
}
