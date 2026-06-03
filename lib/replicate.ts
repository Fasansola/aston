/**
 * lib/replicate.ts
 * ─────────────────────────────────────────────────────────────
 * Kokoro TTS via Replicate API.
 *
 * Required env vars:
 *   REPLICATE_API_TOKEN  — from replicate.com → Account → API tokens
 *
 * Model: jaaari/kokoro-82m — fast, natural, British English voices
 * Docs:  https://replicate.com/jaaari/kokoro-82m
 */

const REPLICATE_BASE = "https://api.replicate.com/v1";

// British English female voice — professional, clear, suits corporate advisory
const DEFAULT_VOICE = "bf_emma";

/**
 * Converts a plain-text script to speech using Kokoro 82M on Replicate.
 * Returns the audio as a Buffer (WAV or MP3 depending on Replicate output).
 *
 * Replicate runs predictions asynchronously — this function polls until done.
 */
export async function generateKokoroSpeech(
  script: string,
  voice = DEFAULT_VOICE
): Promise<{ buffer: Buffer; mimeType: string }> {
  const apiToken = process.env.REPLICATE_API_TOKEN;
  if (!apiToken) {
    throw new Error("Replicate not configured. Missing REPLICATE_API_TOKEN.");
  }

  const wordCount = script.split(/\s+/).filter(Boolean).length;
  console.log(`[replicate] Generating Kokoro TTS — ${wordCount} words, voice: ${voice}`);

  // ── Step 1: Submit prediction ─────────────────────────────
  // jaaari/kokoro-82m is a community model — must use /predictions with version hash
  const createRes = await fetch(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Prefer: "wait=60", // ask Replicate to wait up to 60s before returning
    },
    body: JSON.stringify({
      version: "f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13",
      input: {
        text:  script,
        voice: voice,
        speed: 1.0,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!createRes.ok) {
    const err = await createRes.text().catch(() => createRes.statusText);
    throw new Error(`Replicate prediction failed (${createRes.status}): ${err}`);
  }

  const prediction = await createRes.json() as {
    id: string;
    status: string;
    output?: string | null;
    error?: string | null;
    urls?: { get?: string };
  };

  // ── Step 2: Poll if not immediately done ──────────────────
  let result = prediction;
  if (result.status !== "succeeded" && result.status !== "failed") {
    const pollUrl = result.urls?.get;
    if (!pollUrl) throw new Error("Replicate did not return a poll URL.");

    const deadline = Date.now() + 5 * 60_000; // 5-min max
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));

      const pollRes = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(30_000),
      });

      if (!pollRes.ok) continue;
      result = await pollRes.json() as typeof result;

      if (result.status === "succeeded" || result.status === "failed") break;
      console.log(`[replicate] Kokoro status: ${result.status}…`);
    }
  }

  if (result.status === "failed" || result.error) {
    throw new Error(`Kokoro generation failed: ${result.error ?? "unknown error"}`);
  }

  if (!result.output) {
    throw new Error("Kokoro returned no output URL.");
  }

  // ── Step 3: Download audio file ───────────────────────────
  const audioUrl = typeof result.output === "string" ? result.output : (result.output as string[])[0];
  console.log(`[replicate] Downloading audio from: ${audioUrl.slice(0, 80)}…`);

  const audioRes = await fetch(audioUrl, { signal: AbortSignal.timeout(60_000) });
  if (!audioRes.ok) {
    throw new Error(`Failed to download Kokoro audio (${audioRes.status})`);
  }

  const buffer  = Buffer.from(await audioRes.arrayBuffer());
  // Detect mime type from URL extension; default to wav (Kokoro's typical output)
  const mimeType = audioUrl.includes(".mp3") ? "audio/mpeg" : "audio/wav";
  console.log(`[replicate] Audio ready — ${(buffer.length / 1024).toFixed(1)} KB (${mimeType})`);

  return { buffer, mimeType };
}

/**
 * Strips HTML and builds a clean plain-text narration script from all article fields.
 * Removes visual block markup (infographics, charts, flowcharts, quick-answer, definition)
 * since those are visual-only and make no sense when spoken aloud.
 *
 * Kokoro supports automatic text splitting for long-form input — no hard char limit.
 */
export function articleToAudioScript(
  title: string,
  fields: {
    main_content?: string;
    more_content_1?: string;
    more_content_2?: string;
    more_content_3?: string;
    more_content_4?: string;
    more_content_5?: string; // FAQ
    more_content_6?: string;
    final_points?: string;
  }
): string {
  const stripHtml = (html: string) =>
    (html ?? "")
      // Remove entire aston visual block divs — these are visual-only and unreadable as audio
      .replace(/<div[^>]*class="aston-[^"]*"[\s\S]*?<\/div>/gi, "")
      .replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const parts: string[] = [];

  // Title
  parts.push(`${title}.`);

  // All body sections in order
  if (fields.main_content)   parts.push(stripHtml(fields.main_content));
  if (fields.more_content_1) parts.push(stripHtml(fields.more_content_1));
  if (fields.more_content_2) parts.push(stripHtml(fields.more_content_2));
  if (fields.more_content_3) parts.push(stripHtml(fields.more_content_3));
  if (fields.more_content_4) parts.push(stripHtml(fields.more_content_4));
  if (fields.more_content_6) parts.push(stripHtml(fields.more_content_6));

  // FAQ section
  if (fields.more_content_5) {
    parts.push("Frequently asked questions. " + stripHtml(fields.more_content_5));
  }

  // Final next steps
  if (fields.final_points) {
    const steps = (fields.final_points.match(/<li[^>]*>(.*?)<\/li>/gi) ?? [])
      .map((li) => stripHtml(li))
      .filter(Boolean);
    if (steps.length) {
      parts.push(`Next steps. ${steps.join(". ")}.`);
    }
  }

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
