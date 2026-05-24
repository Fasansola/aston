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
