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

// Voice engine: "elevenlabs" (default) or "kokoro" (free Replicate fallback).
const TTS_PROVIDER = (process.env.PODCAST_TTS_PROVIDER || "elevenlabs").toLowerCase();

// Universal ElevenLabs premade voice IDs (available to all accounts).
const HOST_VOICE   = process.env.ELEVENLABS_PODCAST_HOST_VOICE_ID   || "21m00Tcm4TlvDq8ikWAM"; // Rachel — warm interviewer
const EXPERT_VOICE = process.env.ELEVENLABS_PODCAST_EXPERT_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam — authoritative

// Kokoro voices (jaaari/kokoro-82m): two distinct British voices.
const KOKORO_HOST_VOICE   = process.env.KOKORO_PODCAST_HOST_VOICE   || "bf_emma";   // British female
const KOKORO_EXPERT_VOICE = process.env.KOKORO_PODCAST_EXPERT_VOICE || "bm_george"; // British male

const STING_SECS = 4;

/** Synthesize one turn via ElevenLabs (two premade voices). */
async function synthesizeTurnElevenLabs(turn: DialogueTurn, apiKey: string): Promise<Buffer> {
  const voiceId = turn.speaker === "host" ? HOST_VOICE : EXPERT_VOICE;
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: turn.text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true },
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
async function synthesizeAll(turns: DialogueTurn[]): Promise<Buffer[]> {
  if (TTS_PROVIDER === "kokoro") {
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
 * Build the full episode MP3: [music sting] + turns + [music sting].
 * If BACKGROUND_MUSIC_URL is unset/unreachable, the stings are skipped and the
 * spoken turns are stitched on their own.
 */
export async function buildPodcastEpisode(turns: DialogueTurn[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "podcast-"));
  try {
    // 1. Voice every turn (ElevenLabs or Kokoro, per PODCAST_TTS_PROVIDER)
    const turnBuffers = await synthesizeAll(turns);
    const turnFiles: string[] = [];
    for (let i = 0; i < turnBuffers.length; i++) {
      const f = join(dir, `turn-${String(i).padStart(3, "0")}.mp3`);
      await writeFile(f, turnBuffers[i]);
      turnFiles.push(f);
    }

    // 2. Build music stings (best-effort)
    const stingFiles: { intro?: string; outro?: string } = {};
    const musicUrl = process.env.BACKGROUND_MUSIC_URL;
    if (musicUrl) {
      try {
        const musicRes = await fetch(musicUrl, { signal: AbortSignal.timeout(20_000) });
        if (musicRes.ok) {
          const musicFile = join(dir, "music.mp3");
          await writeFile(musicFile, Buffer.from(await musicRes.arrayBuffer()));
          const introSting = join(dir, "sting-in.mp3");
          const outroSting = join(dir, "sting-out.mp3");
          await ffmpeg(["-y", "-i", musicFile, "-t", String(STING_SECS),
            "-af", `afade=t=in:st=0:d=0.5,afade=t=out:st=${STING_SECS - 1.2}:d=1.2`,
            "-ar", "44100", "-ac", "2", introSting]);
          await ffmpeg(["-y", "-i", musicFile, "-ss", "8", "-t", String(STING_SECS),
            "-af", `afade=t=in:st=0:d=1,afade=t=out:st=${STING_SECS - 1.2}:d=1.2`,
            "-ar", "44100", "-ac", "2", outroSting]);
          stingFiles.intro = introSting;
          stingFiles.outro = outroSting;
        }
      } catch (e) {
        console.warn(`[podcastAudio] music sting skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 3. Concat everything, re-encoding to a uniform stream (handles mixed inputs)
    const sequence = [
      ...(stingFiles.intro ? [stingFiles.intro] : []),
      ...turnFiles,
      ...(stingFiles.outro ? [stingFiles.outro] : []),
    ];
    const inputs = sequence.flatMap((f) => ["-i", f]);
    const filter = sequence.map((_, i) => `[${i}:a]`).join("") + `concat=n=${sequence.length}:v=0:a=1[out]`;
    const outFile = join(dir, "episode.mp3");
    await ffmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "[out]",
      "-ar", "44100", "-ac", "2", "-b:a", "128k", outFile]);

    return await readFile(outFile);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
