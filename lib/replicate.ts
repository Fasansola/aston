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

// Max characters per Replicate prediction — model errors above ~4,000 chars
const KOKORO_CHUNK_LIMIT = 3500;

/**
 * Splits plain text into chunks of at most KOKORO_CHUNK_LIMIT characters,
 * breaking only at sentence boundaries (. ! ?) to avoid mid-sentence cuts.
 */
function splitIntoChunks(text: string): string[] {
  if (text.length <= KOKORO_CHUNK_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > KOKORO_CHUNK_LIMIT) {
    // Find the last sentence boundary within the limit
    const slice   = remaining.slice(0, KOKORO_CHUNK_LIMIT);
    const lastEnd = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? ")
    );
    const cutAt = lastEnd > 0 ? lastEnd + 1 : KOKORO_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Submits a single text chunk to Kokoro on Replicate and returns a raw WAV buffer.
 */
async function generateChunk(
  text: string,
  voice: string,
  apiToken: string
): Promise<Buffer> {
  const createRes = await fetch(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Prefer: "wait=60",
    },
    body: JSON.stringify({
      version: "f559560eb822dc509045f3921a1921234918b91739db4bf3daab2169b71c7a13",
      input: { text, voice, speed: 1.0 },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!createRes.ok) {
    const err = await createRes.text().catch(() => createRes.statusText);
    throw new Error(`Replicate prediction failed (${createRes.status}): ${err}`);
  }

  let result = await createRes.json() as {
    id: string; status: string;
    output?: string | null; error?: string | null;
    urls?: { get?: string };
  };

  // Poll if not immediately done
  if (result.status !== "succeeded" && result.status !== "failed") {
    const pollUrl = result.urls?.get;
    if (!pollUrl) throw new Error("Replicate did not return a poll URL.");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!pollRes.ok) continue;
      result = await pollRes.json() as typeof result;
      if (result.status === "succeeded" || result.status === "failed") break;
    }
  }

  if (result.status === "failed" || result.error) {
    throw new Error(`Kokoro chunk failed: ${result.error ?? "unknown"}`);
  }
  if (!result.output) throw new Error("Kokoro returned no output URL.");

  const audioUrl  = typeof result.output === "string" ? result.output : (result.output as string[])[0];
  const audioRes  = await fetch(audioUrl, { signal: AbortSignal.timeout(60_000) });
  if (!audioRes.ok) throw new Error(`Failed to download chunk audio (${audioRes.status})`);
  return Buffer.from(await audioRes.arrayBuffer());
}

/**
 * Converts a plain-text script to speech using Kokoro 82M on Replicate.
 * Automatically splits long scripts into chunks, generates each, then
 * concatenates and converts to MP3.
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
  const chunks    = splitIntoChunks(script);
  console.log(`[replicate] Kokoro TTS — ${wordCount} words, ${chunks.length} chunk(s), voice: ${voice}`);

  // ── Generate each chunk sequentially with rate-limit backoff ─
  // Replicate throttles to 1 burst request when credit < $5.
  // Wait 12s between chunks (5 per minute = safely under the 6/min cap).
  const wavBuffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      console.log(`[replicate] Waiting 12s before chunk ${i + 1} (rate limit)…`);
      await new Promise((r) => setTimeout(r, 12_000));
    }
    console.log(`[replicate] Chunk ${i + 1}/${chunks.length} — ${chunks[i].length} chars`);

    // Retry up to 3 times on 429
    let wav: Buffer | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        wav = await generateChunk(chunks[i], voice, apiToken);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("429") && attempt < 3) {
          const wait = attempt * 15_000;
          console.log(`[replicate] 429 on chunk ${i + 1}, retrying in ${wait / 1000}s…`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          throw err;
        }
      }
    }
    wavBuffers.push(wav!);
  }

  // ── Validate and log each chunk before concatenation ────────
  for (let i = 0; i < wavBuffers.length; i++) {
    const w = wavBuffers[i];
    if (w.length < 44) {
      throw new Error(`Chunk ${i + 1} WAV too small (${w.length} bytes) — Replicate likely returned empty audio`);
    }
    const ch  = w.readUInt16LE(22);
    const sr  = w.readUInt32LE(24);
    const bps = w.readUInt16LE(34);
    console.log(`[replicate] Chunk ${i + 1} WAV — channels:${ch} sampleRate:${sr} bitsPerSample:${bps} pcmBytes:${w.length - 44}`);
  }

  // ── Concatenate WAV PCM data ──────────────────────────────
  // Keep first header only, strip from remaining chunks, fix RIFF sizes
  let combinedWav: Buffer;
  if (wavBuffers.length === 1) {
    combinedWav = wavBuffers[0];
  } else {
    const header   = Buffer.from(wavBuffers[0].subarray(0, 44));
    const pcmParts = wavBuffers.map((b) => b.subarray(44));
    const pcmData  = Buffer.concat(pcmParts);
    header.writeUInt32LE(pcmData.length,      40); // data chunk size
    header.writeUInt32LE(pcmData.length + 36,  4); // RIFF chunk size
    combinedWav = Buffer.concat([header, pcmData]);
  }

  console.log(`[replicate] Combined WAV — ${(combinedWav.length / 1024).toFixed(1)} KB, converting to MP3…`);
  const buffer = await wavToMp3(combinedWav);
  console.log(`[replicate] MP3 ready — ${(buffer.length / 1024).toFixed(1)} KB`);

  if (buffer.length < 1024) {
    throw new Error(`MP3 output is suspiciously small (${buffer.length} bytes) — WAV conversion likely failed`);
  }

  return { buffer, mimeType: "audio/mpeg" };
}

/**
 * Estimates the duration of an MP3 buffer in seconds.
 *
 * lamejs outputs at 128 kbps (16,000 bytes/sec). This gives a reliable estimate
 * accurate to within ~2% — good enough for proportional timeline calibration.
 * Falls back to a word-count estimate if the buffer is too small to be valid.
 */
export function estimateMp3DurationSeconds(buffer: Buffer): number {
  const MP3_BITRATE_BYTES_PER_SEC = 16_000; // 128 kbps = 16 KB/s
  const MIN_VALID_BYTES = 2_000;
  if (buffer.length < MIN_VALID_BYTES) return 0;
  return buffer.length / MP3_BITRATE_BYTES_PER_SEC;
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
