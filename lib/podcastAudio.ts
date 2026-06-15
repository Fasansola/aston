/**
 * lib/podcastAudio.ts
 * ─────────────────────────────────────────────────────────────
 * Voices a two-speaker dialogue with ElevenLabs (two voices) and stitches it
 * into one episode MP3 with a music sting at the start and end.
 *
 *   music sting (in)  →  [host/expert turns]  →  music sting (out)
 *
 * Stitching uses the bundled ffmpeg-static binary; all work happens in /tmp
 * (writable on Vercel). Reuses BACKGROUND_MUSIC_URL (the video pipeline's track)
 * for the sting, so no new asset is required.
 *
 * Env:
 *   ELEVENLABS_API_KEY                 (required)
 *   ELEVENLABS_PODCAST_HOST_VOICE_ID   (default: premade "Rachel")
 *   ELEVENLABS_PODCAST_EXPERT_VOICE_ID (default: premade "Adam")
 *   BACKGROUND_MUSIC_URL               (optional; sting omitted if unset)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegPath from "ffmpeg-static";
import type { DialogueTurn } from "./podcastDialogue";
import { generateKokoroSpeech } from "./replicate";

const execFileAsync = promisify(execFile);
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

export type TtsProvider = "elevenlabs" | "kokoro";

/** Resolve the voice engine: explicit choice → env default → elevenlabs. */
export function resolveTtsProvider(choice?: string): TtsProvider {
  const v = (choice || process.env.PODCAST_TTS_PROVIDER || "elevenlabs").toLowerCase();
  return v === "kokoro" ? "kokoro" : "elevenlabs";
}

// Universal ElevenLabs premade voice IDs (available to all accounts).
const HOST_VOICE   = process.env.ELEVENLABS_PODCAST_HOST_VOICE_ID   || "21m00Tcm4TlvDq8ikWAM"; // Rachel — warm interviewer
const EXPERT_VOICE = process.env.ELEVENLABS_PODCAST_EXPERT_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam — authoritative

// Kokoro voices (jaaari/kokoro-82m): two distinct British voices.
const KOKORO_HOST_VOICE   = process.env.KOKORO_PODCAST_HOST_VOICE   || "bf_emma";   // British female
const KOKORO_EXPERT_VOICE = process.env.KOKORO_PODCAST_EXPERT_VOICE || "bm_george"; // British male

// Music plays ONLY at the open and close, and is blended into/out of the speech
// with ffmpeg's acrossfade filter (smooth, automatic — no manual fade timing).
// Good fixed defaults so no tuning is needed (still env-overridable).
const INTRO_SECS    = Number(process.env.PODCAST_INTRO_SECS)    || 5;    // music before Liz starts
const OUTRO_SECS    = Number(process.env.PODCAST_OUTRO_SECS)    || 6;    // music after Liz signs off
const CROSSFADE_SEC = Number(process.env.PODCAST_CROSSFADE_SEC) || 1.5;  // blend between music and speech
const INTRO_VOLUME  = Number(process.env.PODCAST_INTRO_VOLUME)  || 0.35;
const OUTRO_VOLUME  = Number(process.env.PODCAST_OUTRO_VOLUME)  || 0.32;

/** Synthesize one turn via ElevenLabs (two premade voices). */
async function synthesizeTurnElevenLabs(turn: DialogueTurn, apiKey: string): Promise<Buffer> {
  const voiceId = turn.speaker === "host" ? HOST_VOICE : EXPERT_VOICE;
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: turn.text,
      model_id: "eleven_multilingual_v2",
      // Lower stability = more natural variation/emotion (less monotone); a touch
      // more style for conversational inflection. Tuned for podcast dialogue.
      voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.55, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${err.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Synthesize one turn via Kokoro (free, Replicate) using two distinct voices. */
async function synthesizeTurnKokoro(turn: DialogueTurn): Promise<Buffer> {
  const voice = turn.speaker === "host" ? KOKORO_HOST_VOICE : KOKORO_EXPERT_VOICE;
  const { buffer } = await generateKokoroSpeech(turn.text, voice);
  return buffer;
}

/**
 * Synthesize every turn. ElevenLabs runs with bounded concurrency; Kokoro runs
 * sequentially because Replicate heavily rate-limits low-credit accounts.
 */
async function synthesizeAll(turns: DialogueTurn[], provider: TtsProvider): Promise<Buffer[]> {
  if (provider === "kokoro") {
    const out: Buffer[] = [];
    for (const turn of turns) out.push(await synthesizeTurnKokoro(turn));
    return out;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const out: Buffer[] = new Array(turns.length);
  let next = 0;
  const worker = async () => {
    while (next < turns.length) {
      const i = next++;
      out[i] = await synthesizeTurnElevenLabs(turns[i], apiKey);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, turns.length) }, worker));
  return out;
}

async function ffmpeg(args: string[]): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not found (ffmpeg-static)");
  await execFileAsync(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 });
}

/**
 * Build the full episode MP3:
 *   [music intro] ⤬ clean conversation ⤬ [music outro]
 * The intro music blends into the speech and the speech blends into the outro
 * music using ffmpeg's acrossfade filter — smooth, automatic crossfades with no
 * manual fade timing. No music plays under the body of the conversation.
 * If BACKGROUND_MUSIC_URL is unset/unreachable, the speech is returned on its own.
 */
export async function buildPodcastEpisode(turns: DialogueTurn[], provider: TtsProvider = "elevenlabs"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "podcast-"));
  try {
    // 1. Voice every turn with the chosen engine
    const turnBuffers = await synthesizeAll(turns, provider);
    const turnFiles: string[] = [];
    for (let i = 0; i < turnBuffers.length; i++) {
      const f = join(dir, `turn-${String(i).padStart(3, "0")}.mp3`);
      await writeFile(f, turnBuffers[i]);
      turnFiles.push(f);
    }

    // 2. Concat all turns into one uniform speech track (clean — no music here)
    const speechFile = join(dir, "speech.mp3");
    const speechInputs = turnFiles.flatMap((f) => ["-i", f]);
    const speechFilter = turnFiles.map((_, i) => `[${i}:a]`).join("") + `concat=n=${turnFiles.length}:v=0:a=1[out]`;
    await ffmpeg(["-y", ...speechInputs, "-filter_complex", speechFilter, "-map", "[out]",
      "-ar", "44100", "-ac", "2", "-b:a", "128k", speechFile]);

    // 3. Crossfade a music intro in and a music outro out (best-effort)
    const musicUrl = process.env.BACKGROUND_MUSIC_URL;
    if (musicUrl) {
      try {
        const musicRes = await fetch(musicUrl, { signal: AbortSignal.timeout(20_000) });
        if (musicRes.ok) {
          const musicFile = join(dir, "music.mp3");
          await writeFile(musicFile, Buffer.from(await musicRes.arrayBuffer()));

          const episodeFile = join(dir, "episode.mp3");
          // One pass: take two slices of the music (intro + a different outro
          // section), level + edge-fade them, then acrossfade intro→speech and
          // speech→outro. acrossfade overlaps each pair by CROSSFADE_SEC and
          // blends automatically, so no duration math is needed.
          await ffmpeg([
            "-y",
            "-i", speechFile,   // 0
            "-i", musicFile,    // 1 → intro slice
            "-i", musicFile,    // 2 → outro slice
            "-filter_complex",
            `[1:a]atrim=0:${INTRO_SECS},asetpts=PTS-STARTPTS,volume=${INTRO_VOLUME},afade=t=in:st=0:d=0.8[intro];` +
            `[2:a]atrim=8:${8 + OUTRO_SECS},asetpts=PTS-STARTPTS,volume=${OUTRO_VOLUME},afade=t=out:st=${Math.max(0.1, OUTRO_SECS - 2.5)}:d=2.5[outro];` +
            `[intro][0:a]acrossfade=d=${CROSSFADE_SEC}:c1=tri:c2=tri[a];` +
            `[a][outro]acrossfade=d=${CROSSFADE_SEC}:c1=tri:c2=tri[out]`,
            "-map", "[out]", "-ar", "44100", "-ac", "2", "-b:a", "128k", episodeFile,
          ]);
          return await readFile(episodeFile);
        }
      } catch (e) {
        console.warn(`[podcastAudio] music intro/outro skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // No music (or it failed) — return the clean speech track on its own
    return await readFile(speechFile);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
