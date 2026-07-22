/**
 * lib/elevenlabs.ts
 * ─────────────────────────────────────────────────────────────
 * Generates spoken-word audio from a script using the ElevenLabs API.
 *
 * Required env vars:
 *   ELEVENLABS_API_KEY   — from elevenlabs.io → Profile → API Keys
 *   ELEVENLABS_VOICE_ID  — voice ID from your ElevenLabs voice library
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

/**
 * Converts a script to speech using ElevenLabs.
 * Returns the audio as a Buffer (MP3).
 */
export async function generateSpeech(script: string): Promise<Buffer> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID!;
  const apiKey  = process.env.ELEVENLABS_API_KEY!;

  if (!voiceId || !apiKey) {
    throw new Error("ElevenLabs not configured. Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.");
  }

  console.log(`[elevenlabs] Generating speech — ${script.split(/\s+/).length} words, voice: ${voiceId}`);

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key":   apiKey,
      "Content-Type": "application/json",
      "Accept":       "audio/mpeg",
    },
    body: JSON.stringify({
      text:     script,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability:         0.35,  // lower = more natural variation in delivery, less robotic
        similarity_boost:  0.75,  // voice fidelity to the chosen voice
        style:             0.45,  // higher style = more emotional range and inflection
        use_speaker_boost: true,  // enhances presence and clarity
      },
    }),
    signal: AbortSignal.timeout(120_000), // 2-min timeout for long scripts
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    console.error(`[elevenlabs] Failed (${res.status}):`, err);
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  console.log(`[elevenlabs] Audio ready — ${(buffer.length / 1024).toFixed(1)} KB`);
  return buffer;
}

export interface WordTiming {
  word: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
}

/**
 * Same as generateSpeech, but uses the with-timestamps endpoint so we also get
 * back the exact timing of every spoken word. Since the reel avatar is
 * lip-synced to THIS audio, these timings align perfectly with the video —
 * which is what lets us burn word-accurate captions onto it.
 *
 * The API returns character-level alignment; we fold characters back into words.
 */
export async function generateSpeechWithTimestamps(
  script: string
): Promise<{ audio: Buffer; words: WordTiming[] }> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID!;
  const apiKey = process.env.ELEVENLABS_API_KEY!;
  if (!voiceId || !apiKey) {
    throw new Error("ElevenLabs not configured. Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID.");
  }

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      text: script,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.45, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS (timestamps) failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as {
    audio_base64: string;
    alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  };

  const audio = Buffer.from(data.audio_base64, "base64");
  const words = foldCharactersIntoWords(data.alignment);
  console.log(`[elevenlabs] Audio + timestamps ready — ${words.length} words`);
  return { audio, words };
}

/** Collapse the character-level alignment into word-level timings. */
function foldCharactersIntoWords(alignment?: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): WordTiming[] {
  if (!alignment) return [];
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment;
  const words: WordTiming[] = [];
  let current = "";
  let wordStart = 0;

  const flush = (end: number) => {
    const w = current.trim();
    if (w) words.push({ word: w, start: wordStart, end });
    current = "";
  };

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      if (current.trim()) flush(ends[i - 1] ?? starts[i]);
      continue;
    }
    if (!current) wordStart = starts[i];
    current += ch;
  }
  if (current.trim()) flush(ends[characters.length - 1] ?? wordStart);
  return words;
}
