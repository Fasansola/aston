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

// Music plays ONLY at the open and close — never under the conversation.
// Good fixed defaults so no tuning is needed (still env-overridable).
const INTRO_SECS   = Number(process.env.PODCAST_INTRO_SECS)   || 4;    // subtle intro length
const INTRO_VOLUME = Number(process.env.PODCAST_INTRO_VOLUME) || 0.25; // intro plays alone, so a touch more present
const OUTRO_VOLUME = Number(process.env.PODCAST_OUTRO_VOLUME) || 0.10; // fades in quietly UNDER Liz's outro

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

/** Parse a media file's duration (seconds) from ffmpeg's stderr. Returns 0 if unknown. */
async function probeDurationSecs(file: string): Promise<number> {
  try {
    await ffmpeg(["-i", file]); // no output specified → ffmpeg errors but prints "Duration:"
    return 0;
  } catch (e) {
    const stderr = (e as { stderr?: string })?.stderr ?? String(e);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
  }
}

/**
 * Build the full episode MP3:
 *   [subtle music intro ~4s] → clean conversation (no music) → music fades in
 *   quietly under Liz's outro and plays out.
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

    // 3. Add the music intro + outro only (best-effort)
    const musicUrl = process.env.BACKGROUND_MUSIC_URL;
    if (musicUrl) {
      try {
        const musicRes = await fetch(musicUrl, { signal: AbortSignal.timeout(20_000) });
        if (musicRes.ok) {
          const musicFile = join(dir, "music.mp3");
          await writeFile(musicFile, Buffer.from(await musicRes.arrayBuffer()));

          // 3a. Subtle intro sting (plays alone, fades out as Liz starts)
          const introFile = join(dir, "intro.mp3");
          await ffmpeg(["-y", "-i", musicFile, "-t", String(INTRO_SECS),
            "-af", `volume=${INTRO_VOLUME},afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0.1, INTRO_SECS - 1.4)}:d=1.4`,
            "-ar", "44100", "-ac", "2", introFile]);

          // 3b. intro + clean speech
          const combinedFile = join(dir, "combined.mp3");
          await ffmpeg(["-y", "-i", introFile, "-i", speechFile,
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[out]", "-map", "[out]",
            "-ar", "44100", "-ac", "2", "-b:a", "128k", combinedFile]);

          // 3c. Music fades in quietly under Liz's final turn and plays out
          const Dc = await probeDurationSecs(combinedFile);
          const L  = await probeDurationSecs(turnFiles[turnFiles.length - 1]);
          const outroStart = (Dc > 0 && L > 0) ? Math.max(0, Dc - L) : (Dc > 6 ? Dc - 6 : 0);
          const bedFades =
            `afade=t=in:st=${outroStart.toFixed(2)}:d=2` +
            (Dc > 0 ? `,afade=t=out:st=${(Dc + 0.5).toFixed(2)}:d=2.5` : "");
          const episodeFile = join(dir, "episode.mp3");
          await ffmpeg([
            "-y",
            "-i", combinedFile,
            "-stream_loop", "-1", "-i", musicFile,
            "-filter_complex",
            `[0:a]apad=pad_dur=3[sp];` +                                  // room for the music tail
            `[1:a]volume=${OUTRO_VOLUME},${bedFades}[bed];` +             // silent until the outro, then fades in/out
            `[sp][bed]amix=inputs=2:duration=first:normalize=0[out]`,
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
