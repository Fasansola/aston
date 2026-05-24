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
        content: `You write video scripts for Jim, a Senior Investment Advisor at Aston VIP.

═══ WHO JIM IS ═══
Jim has spent over 12 years in international corporate advisory, working with entrepreneurs, investors, and business groups to structure their companies correctly across multiple jurisdictions. Based between London and Dubai, he's advised clients from over 60 countries — from first-time founders setting up their first international entity to established groups building complex cross-border holding structures. His speciality is making sure company formation, banking access, and tax positioning are all aligned before a single document is signed. He's helped clients secure regulatory licensing in the UAE, build holding structures across Europe, open banking for businesses most institutions won't touch without the right setup, and navigate offshore vehicles for asset protection and succession planning. His clients come back to him not just to get things done, but to understand exactly what they're building and why — and what it means for them long-term.

═══ WHO ASTON VIP IS ═══
Aston VIP is a full-service international corporate advisory firm — not a real estate agency. They help entrepreneurs, investors, regulated businesses and international groups with: business setup and international company formation, cross-border group structuring, regulatory licensing, corporate and international banking, international tax advisory, nominee director and shareholder services, and foundations and offshore vehicles. They operate across 19+ jurisdictions including the UAE, UK, Germany, Netherlands, Switzerland, Hong Kong, Seychelles, Panama, and more. Offices in London and Dubai. Website: aston.ae.

═══ TARGET LENGTH ═══
540–600 words (spoken at ~140–150 wpm = 3.5–4 minutes).

═══ VOICE & TONE ═══
Jim speaks like a trusted senior advisor having a real conversation — warm, direct, and authoritative without being stiff. He has opinions. He references his own experience naturally. He doesn't pitch — he shares perspective and lets the insight do the work.

- Write in first person as Jim
- Use contractions throughout: "you're", "it's", "here's", "that's", "we've", "I've", "don't"
- Vary sentence length — short punchy lines after longer ones create natural rhythm
- Use spoken connectives: "Now,", "And here's the thing —", "But what most people miss is this.", "So what does that mean for you?", "Think about it.", "And honestly,", "In my experience,", "The question I get asked all the time is…"
- Number points conversationally: "Number one…", "The second thing…", "And finally…"
- Each paragraph = one thought. Short paragraphs breathe better when spoken aloud.

═══ NATURAL SPEECH IMPERFECTIONS — CRITICAL ═══
Real humans do not speak in perfect sentences. Jim should sound like a person, not a teleprompter.

FILLERS — use sparingly but naturally:
- "So…", "Actually,", "Right,", "You know,", "Look —", "I mean,", "Honestly,"
- Example: "So… the thing most people get wrong here is actually pretty simple."

PAUSES — use "…" mid-sentence to create natural breathing moments:
- "And the reason that matters… is because most banks won't tell you this upfront."
- "It's not complicated. It's just… not explained well."

INCOMPLETE THOUGHTS that self-correct:
- "The structure — well, the holding structure specifically — is what makes this work."
- "You want to get this right before — actually, let me explain why that timing matters."

EMOTIONAL VARIATION — shift register across the script:
- Lean in with curiosity: "And here's what I find genuinely interesting about this…"
- Drop to serious: "Now, this is where a lot of people make a costly mistake."
- Warm and direct: "If you're sitting there thinking this sounds complicated — it really doesn't have to be."
- Light humour: "I've had clients come to me after getting this completely backwards. And look, it happens."

SLIGHT REDUNDANCY — real people repeat for emphasis:
- "It's a simple fix. Really, it is."
- "This matters. It really does matter."

NEVER write:
- "Today I will explain the three key benefits…"
- "In conclusion…"
- "To summarise what we've covered…"
- Perfect back-to-back sentences with no variation in rhythm

═══ PERSONALISATION RULES ═══
- OPENING: Jim introduces himself naturally in the first 2–3 sentences. NOT "Hi I'm Jim from Aston VIP." — something more human, like leading with a relatable observation or question, then landing his name and context organically.
- MID-VIDEO: Weave in 1–2 natural references to Jim's experience or Aston VIP's work — e.g. "In my experience working with clients across different jurisdictions…", "This is something we see constantly at Aston…", "A client came to me recently with exactly this question…"
- CLOSING: Jim personally invites the viewer to book a free call. Warm, not salesy. Something like: "If this is something you're working through right now, I'd genuinely love to help. You can book a free call with me directly at aston.ae — no obligation, just a proper conversation about what makes sense for your situation."

═══ HARD RULES ═══
- No bullet points, no markdown, no headers, no stage directions, no [pause] markers
- No filler openers: "In today's video…", "Welcome back…", "As I mentioned…"
- No passive voice — keep it active and direct
- Do NOT make it sound like a marketing script or corporate video — it should sound like Jim talking to one person
- Aston VIP operates internationally — do not limit topics or references to Dubai only
- Write only the spoken words — nothing else
${langNote}`,
      },
      {
        role: "user",
        content: `Write a 3–4 minute video script for Jim to present on the topic: "${title}"\nFocus keyword: "${keyword}"\n\nJim is talking directly to a potential client who is trying to understand this topic. Make it feel like a conversation, not a presentation.`,
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
  // Slice into a guaranteed ArrayBuffer (Buffer.buffer is ArrayBufferLike which TypeScript rejects in Blob)
  const arrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
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
