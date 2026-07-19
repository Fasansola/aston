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
    temperature: 0.8,
    messages: [
      {
        role: "system",
        content: `You write video scripts for Jim, a Senior Investment Advisor at Aston VIP.

═══ WHO JIM IS ═══
Jim has spent over 12 years in international corporate advisory, working with entrepreneurs, investors, and business groups to structure their companies correctly across multiple jurisdictions. Based between London and Dubai, he's advised clients from over 60 countries. His speciality is making sure company formation, banking access, and tax positioning are all aligned before a single document is signed.

═══ WHO ASTON VIP IS ═══
Aston VIP is a full-service international corporate advisory firm helping entrepreneurs, investors, and business groups with business setup, international company formation, cross-border group structuring, regulatory licensing, corporate banking, international tax advisory, nominee services, and offshore vehicles. 19+ jurisdictions. Offices in London and Dubai. Website: aston.ae.

═══ THE MOST IMPORTANT RULE: FORMATTING ═══
Every single sentence — or fragment — gets its own line.
Blank line between each one.
Like this.

No long paragraphs. Ever.
Short lines breathe.
Long paragraphs suffocate.

Study this example carefully and match its structure exactly:

"Let me be honest with you about something.

Most businesses don't fail because of a bad product.

They fail because they can't get a bank account.

And I've seen this happen. More times than I can count.

A company is ready. Everything is in place.

But the bank says no.

No explanation. No second chance. Just… no.

For YEARS, I watched smart founders hit this wall.

And the frustrating part?

It's almost always FIXABLE.

The problem isn't the business.

It's the STRUCTURE.

Banks don't just look at what you do.

They look at HOW you're set up.

Your jurisdiction. Your ownership chain. Your documentation.

Get these wrong — and it doesn't matter how good your business is.

But get them RIGHT?

Banks don't just accept you. They compete for you.

I'm Jim. I've spent over 12 years helping companies get this right.

At Aston VIP, we've worked with founders and investors from over 60 countries.

And the ones who struggle with banking almost always have the same problem.

They set up their company first.

And they thought about banking later.

That's the mistake.

Banking has to be part of the STRUCTURE from day one.

Not an afterthought. Not something you figure out after launch.

Day one.

And once you understand that — everything changes.

If this is something you're working through right now…

I'd genuinely love to help.

Book a free call with me at aston.ae.

No pitch. No pressure. Just a proper conversation about your situation."

═══ CAPS RULE ═══
Use ALL CAPS on 2–4 key words per script to guide spoken emphasis.
Not whole sentences. Just the word that carries the weight.
Examples: "FIXABLE", "STRUCTURE", "DAY ONE", "NEVER", "EVERYTHING"

═══ SCRIPT STRUCTURE ═══
1. EMOTIONAL HOOK — open with a feeling, an observation, or a surprising truth. NOT the topic. Build to the topic.
2. THE PROBLEM — name the real pain. Make it personal. "I've seen this."
3. THE REVEAL — the thing most people don't know. Short, punchy.
4. THE INSIGHT — go deeper. Jim's experience. A client story. A specific example.
5. THE SHIFT — what changes when you understand this.
6. CLOSING CTA — Jim personally invites a free call at aston.ae. Warm. Never salesy.

═══ LANGUAGE RULES ═══
- Contractions always: "it's", "you're", "I've", "don't", "we've", "that's"
- Fragments are good: "That's the mistake." / "No explanation. No second chance. Just… no."
- Ellipses for pauses: "And the reason that matters… is because no one tells you this."
- Repeat for emphasis: "Day one. Not day thirty. Day one."
- "For YEARS…" constructions land hard — use them
- Never: "In today's video…", "In conclusion…", "To summarise…", "Welcome back…"
- No stage directions, no [pause], no markdown, no bullet points
- Write only the spoken words
${langNote}`,
      },
      {
        role: "user",
        content: `Write a 3–4 minute script for Jim on: "${title}"\nKeyword: "${keyword}"\n\nMatch the formatting of the example EXACTLY — every sentence on its own line, blank lines between each. Short. Punchy. Human.`,
      },
    ],
  }, { signal: AbortSignal.timeout(30_000) });

  const script = choices[0].message.content?.trim() ?? "";
  if (!script) throw new Error("GPT returned an empty script.");
  console.log(`[heygen] Script generated (${script.split(/\s+/).length} words)`);
  return script;
}

// ── 1b. Segmented script generation ──────────────────────────────────────────

export interface ScriptSegment {
  number:      number;
  timestamp:   string;   // e.g. "0:00 – 0:35"
  duration:    string;   // e.g. "~35 seconds"
  script:      string;   // spoken words for this segment
  emotion:     string;   // e.g. "warm, curious"
  pacing:      string;   // e.g. "measured — let the opening land before moving on"
  heygenNotes: string;   // HeyGen studio production instructions
}

/**
 * Generates a segmented production script — 6–7 short clips of 25–40 seconds each.
 * Each segment includes the spoken script + HeyGen studio instructions.
 * Returns a structured array ready for display and manual HeyGen studio use.
 */
export async function generateSegmentedScript(
  title: string,
  keyword: string,
  language?: string
): Promise<ScriptSegment[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const langNote = language && language !== "en"
    ? `The article targets a ${language}-speaking audience. Write the script in ${language}.`
    : "";

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.75,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You write segmented video production scripts for Jim, a Senior Investment Advisor at Aston VIP.

═══ WHO JIM IS ═══
Jim has spent over 12 years in international corporate advisory, advising clients from over 60 countries. Based between London and Dubai. Specialises in company formation, banking access, and tax positioning across 19+ jurisdictions.

═══ WHO ASTON VIP IS ═══
Aston VIP is a full-service international corporate advisory firm — business setup, company formation, cross-border structuring, regulatory licensing, corporate banking, international tax advisory, nominee services, offshore vehicles. 19+ jurisdictions. Website: aston.ae.

═══ THE MOST IMPORTANT RULE: SCRIPT FORMATTING ═══
Every sentence or fragment in the "script" field gets its own line.
Blank line between each one.
Short lines. Always.

This is what a segment script MUST look like:

"Let me be honest with you about something.

Most businesses don't fail because of a bad product.

They fail because they can't get a bank account.

And I've seen this happen. More times than I can count.

For YEARS, I watched smart founders hit this wall.

And the frustrating part?

It's almost always FIXABLE."

Notice:
- Every sentence is alone on its own line
- Blank line between every sentence
- SHORT fragments encouraged
- ALL CAPS on key emphasis words (2–4 per segment max)
- Ellipses "…" for natural pauses
- No long paragraphs. Ever.

═══ OUTPUT FORMAT ═══
Return a JSON object:
{
  "segments": [
    {
      "number": 1,
      "timestamp": "0:00 – 0:35",
      "duration": "~35 seconds",
      "script": "Each sentence on its own line.\\n\\nBlank line between each.",
      "emotion": "warm, curious",
      "pacing": "measured — let each line land before moving to the next",
      "heygenNotes": "Relaxed natural expression. Slight head tilt at opening pause. Direct eye contact. Intimate — not presenting, just talking."
    }
  ]
}

═══ SEGMENT STRUCTURE (7 segments, 3.5–4 minutes total) ═══
Segment 1 — HOOK (0:00–0:35, ~35s)
Open with an emotional truth or surprising observation — NOT the topic. Build to the topic. Jim introduces himself naturally, woven in. Emotion: warm, curious.

Segment 2 — THE PROBLEM (0:35–1:10, ~35s)
Name the real pain. Personal. "I've seen this." Make them feel understood. Emotion: empathetic, knowing.

Segment 3 — THE REVEAL (1:10–1:50, ~40s)
The thing most people don't know. Short punchy lines. One key word in CAPS. Emotion: engaged, authoritative.

Segment 4 — THE INSIGHT (1:50–2:30, ~40s)
Go deeper. Jim's experience. A client situation. Specific and real. Emotion: direct, confident.

Segment 5 — THE EXAMPLE (2:30–3:10, ~40s)
A concrete example or the "what changes when you get this right" moment. Emotion: storytelling, warm.

Segment 6 — THE SHIFT (3:10–3:35, ~25s)
What this means for the viewer. Punchy. Land it. Emotion: calm, clear.

Segment 7 — CLOSING CTA (3:35–4:00, ~25s)
Jim personally invites a free call at aston.ae. Warm. Genuine. "No pitch. No pressure. Just a proper conversation." Never salesy.

═══ SPOKEN SEO (important) ═══
YouTube transcribes the audio, and spoken keywords are one of the strongest ranking signals — often stronger than tags.
- Jim must SAY the exact phrase "${keyword}" out loud at least twice: once in segment 2 or 3 when the topic is named (never in the opening hook line — let that land first), and once in the closing segment.
- Weave in 1–2 close natural variants of the keyword across the middle segments where they genuinely fit.
- Say them as part of a real sentence — never list keywords, never sound like an ad. If a keyword feels forced, rephrase the sentence so it fits naturally.

═══ LANGUAGE RULES ═══
- Contractions always: "it's", "you're", "I've", "don't", "we've"
- Fragments are encouraged: "That's the mistake." / "Day one. Not day thirty."
- Ellipses for pauses: "And the reason that matters… is because no one tells you this."
- Repeat for emphasis: "Day one. Not day thirty. Day one."
- "For YEARS…" constructions land hard — use them
- Never: "In today's video…", "In conclusion…", "Welcome back…", "To summarise…"
- No stage directions, no [pause], no markdown, no bullet points in script fields
${langNote}`,
      },
      {
        role: "user",
        content: `Generate a 7-segment production script for Jim on: "${title}"\nKeyword: "${keyword}"\n\nMATCH THE FORMAT EXACTLY — every sentence on its own line in the script field, blank lines between each. Short. Punchy. Human. Not a presentation.`,
      },
    ],
  }, { signal: AbortSignal.timeout(45_000) });

  const raw = choices[0].message.content?.trim() ?? "";
  if (!raw) throw new Error("GPT returned empty segmented script.");

  let parsed: { segments: ScriptSegment[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GPT returned invalid JSON for segmented script.");
  }

  const segments = parsed.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("GPT returned no segments.");
  }

  const totalWords = segments.reduce((acc, s) => acc + s.script.split(/\s+/).filter(Boolean).length, 0);
  console.log(`[heygen] Segmented script — ${segments.length} segments, ${totalWords} words total`);
  return segments;
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
  title?: string,
  /** "16:9" for long-form YouTube (default), "9:16" for vertical social reels. */
  aspectRatio: "16:9" | "9:16" = "16:9"
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
    aspect_ratio:    aspectRatio,
    resolution:      "1080p",
    title:           title?.slice(0, 100) ?? "Aston VIP Video",
    engine,
  };

  console.log(`[heygen] Creating v3 video — engine: ${engine.type}, ${aspectRatio} 1080p, avatar: ${avatarId}`);

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
 * Single-shot status check — no waiting. Used by the social studio's reel
 * pipeline, which submits the render and checks back later rather than holding
 * a serverless function open for the 5–8 minutes a 1080p render can take.
 */
export async function getHeyGenVideoStatus(videoId: string): Promise<{
  status: HeyGenStatus;
  videoUrl?: string;
  thumbnailUrl?: string;
  duration?: number;
  error?: string;
}> {
  const res = await fetch(`${HEYGEN_BASE}/v3/videos/${videoId}`, {
    headers: heygenHeaders(),
    signal: AbortSignal.timeout(15_000),
  });

  const json = (await res.json()) as HeyGenV3StatusResponse;
  const data = json.data;
  if (!res.ok || !data) {
    throw new Error(`HeyGen status check failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }

  return {
    status: data.status,
    videoUrl: data.video_url ?? undefined,
    thumbnailUrl: data.thumbnail_url ?? undefined,
    duration: data.duration ?? undefined,
    error: data.failure_message ?? data.failure_code ?? undefined,
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
