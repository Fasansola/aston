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

type Mp3EncoderType = {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  };
};

async function getLamejs(): Promise<Mp3EncoderType> {
  const mod = await import("@breezystack/lamejs");
  return (mod.default ?? mod) as unknown as Mp3EncoderType;
}

const REPLICATE_BASE = "https://api.replicate.com/v1";

/**
 * Converts a WAV Buffer to MP3 using @breezystack/lamejs (pure JS, no native binaries).
 * Reads the WAV header to extract sample rate and channel count.
 */
async function wavToMp3(wavBuffer: Buffer): Promise<Buffer> {
  const { Mp3Encoder } = await getLamejs();

  // WAV header offsets:
  // 22 = numChannels (2 bytes), 24 = sampleRate (4 bytes), 34 = bitsPerSample (2 bytes)
  const numChannels   = wavBuffer.readUInt16LE(22);
  const sampleRate    = wavBuffer.readUInt32LE(24);
  const bitsPerSample = wavBuffer.readUInt16LE(34);

  // PCM data starts after the 44-byte WAV header
  const dataOffset = 44;
  const pcmData    = wavBuffer.subarray(dataOffset);

  // Convert raw bytes to Int16Array (16-bit PCM samples)
  const samples = new Int16Array(
    pcmData.buffer,
    pcmData.byteOffset,
    pcmData.byteLength / (bitsPerSample / 8)
  );

  const encoder   = new Mp3Encoder(numChannels, sampleRate, 128);
  const mp3Parts: Buffer[] = [];
  const blockSize = 1152; // standard LAME block size

  if (numChannels === 1) {
    for (let i = 0; i < samples.length; i += blockSize) {
      const chunk   = samples.subarray(i, i + blockSize);
      const encoded = encoder.encodeBuffer(chunk);
      if (encoded.length > 0) mp3Parts.push(Buffer.from(encoded));
    }
  } else {
    // Stereo — split into left/right channels
    const left  = new Int16Array(samples.length / 2);
    const right = new Int16Array(samples.length / 2);
    for (let i = 0, j = 0; i < samples.length; i += 2, j++) {
      left[j]  = samples[i];
      right[j] = samples[i + 1];
    }
    for (let i = 0; i < left.length; i += blockSize) {
      const lChunk  = left.subarray(i, i + blockSize);
      const rChunk  = right.subarray(i, i + blockSize);
      const encoded = encoder.encodeBuffer(lChunk, rChunk);
      if (encoded.length > 0) mp3Parts.push(Buffer.from(encoded));
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) mp3Parts.push(Buffer.from(flushed));

  return Buffer.concat(mp3Parts);
}

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

  const rawBuffer = Buffer.from(await audioRes.arrayBuffer());
  console.log(`[replicate] Raw audio downloaded — ${(rawBuffer.length / 1024).toFixed(1)} KB`);

  // Convert WAV → MP3 for universal browser compatibility
  // MP3 plays reliably in all browsers; WAV can fail on some setups
  let buffer: Buffer;
  let mimeType: string;

  if (audioUrl.includes(".mp3")) {
    buffer   = rawBuffer;
    mimeType = "audio/mpeg";
    console.log(`[replicate] Already MP3 — no conversion needed`);
  } else {
    console.log(`[replicate] Converting WAV → MP3…`);
    buffer   = await wavToMp3(rawBuffer);
    mimeType = "audio/mpeg";
    console.log(`[replicate] MP3 ready — ${(buffer.length / 1024).toFixed(1)} KB`);
  }

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
