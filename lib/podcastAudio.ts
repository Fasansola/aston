/**
 * lib/podcastAudio.ts
 * ─────────────────────────────────────────────────────────────
 * Voices a two-speaker dialogue with ElevenLabs (two voices) and stitches it
 * into one episode MP3 with a music sting at the start and end.
 *
 *   music sting (in)  →  [host/expert turns]  →  music sting (out)
 *
 * Also exports generateElevenLabsNarration for single-voice video voiceover.
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

const execFileAsync = promisify(execFile);
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Universal ElevenLabs premade voice IDs (available to all accounts).
const HOST_VOICE   = process.env.ELEVENLABS_PODCAST_HOST_VOICE_ID   || "21m00Tcm4TlvDq8ikWAM"; // Rachel — warm interviewer
const EXPERT_VOICE = process.env.ELEVENLABS_PODCAST_EXPERT_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // Adam — authoritative

// Music plays ONLY at the open and close. Each clip has explicit afade edges
// so fades are guaranteed — no EOS detection needed. All env-overridable.
const INTRO_SECS    = Number(process.env.PODCAST_INTRO_SECS)    || 6;
const OUTRO_SECS    = Number(process.env.PODCAST_OUTRO_SECS)    || 10;
const INTRO_VOLUME  = Number(process.env.PODCAST_INTRO_VOLUME)  || 0.20;
const OUTRO_VOLUME  = Number(process.env.PODCAST_OUTRO_VOLUME)  || 0.16;

/** Synthesize one dialogue turn via ElevenLabs. */
async function synthesizeTurn(turn: DialogueTurn, apiKey: string): Promise<Buffer> {
  const voiceId = turn.speaker === "host" ? HOST_VOICE : EXPERT_VOICE;
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: turn.text,
      model_id: "eleven_multilingual_v2",
      // Lower stability = more natural variation/emotion; a touch of style for
      // conversational inflection. Tuned for podcast dialogue.
      voice_settings: { stability: 0.52, similarity_boost: 0.80, style: 0.22, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${err.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Synthesize all dialogue turns with bounded concurrency (max 4 parallel). */
async function synthesizeAll(turns: DialogueTurn[]): Promise<Buffer[]> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const out: Buffer[] = new Array(turns.length);
  let next = 0;
  const worker = async () => {
    while (next < turns.length) {
      const i = next++;
      out[i] = await synthesizeTurn(turns[i], apiKey);
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
 * If BACKGROUND_MUSIC_URL is unset/unreachable, the speech is returned on its own.
 */
export async function buildPodcastEpisode(turns: DialogueTurn[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "podcast-"));
  try {
    // 1. Voice every turn with ElevenLabs
    const turnBuffers = await synthesizeAll(turns);
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
          const introFadeOut = Math.max(0.1, INTRO_SECS - 2);
          const outroFadeOut = Math.max(0.1, OUTRO_SECS - 3);
          await ffmpeg([
            "-y",
            "-i", speechFile,                      // 0: speech
            "-stream_loop", "-1", "-i", musicFile, // 1: intro
            "-stream_loop", "-1", "-i", musicFile, // 2: outro
            "-filter_complex",
            `[1:a]atrim=0:${INTRO_SECS},asetpts=PTS-STARTPTS,` +
            `aformat=sample_rates=44100:channel_layouts=stereo,` +
            `volume=${INTRO_VOLUME},` +
            `afade=t=in:st=0:d=0.8,afade=t=out:st=${introFadeOut}:d=2[intro];` +
            `[2:a]atrim=0:${OUTRO_SECS},asetpts=PTS-STARTPTS,` +
            `aformat=sample_rates=44100:channel_layouts=stereo,` +
            `volume=${OUTRO_VOLUME},` +
            `afade=t=in:st=0:d=1.5,afade=t=out:st=${outroFadeOut}:d=3[outro];` +
            `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[sp];` +
            `[intro][sp][outro]concat=n=3:v=0:a=1[out]`,
            "-map", "[out]", "-ar", "44100", "-ac", "2", "-b:a", "128k", episodeFile,
          ]);
          return await readFile(episodeFile);
        }
      } catch (e) {
        console.warn(`[podcastAudio] music intro/outro skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return await readFile(speechFile);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Single-voice narration for video voiceover ────────────────

const NARRATION_CHUNK_LIMIT = 2400;

function splitScriptIntoChunks(text: string): string[] {
  if (text.length <= NARRATION_CHUNK_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > NARRATION_CHUNK_LIMIT) {
    const slice = remaining.slice(0, NARRATION_CHUNK_LIMIT);
    const lastSentence = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
    );
    const cutAt = lastSentence > 0 ? lastSentence + 2 : NARRATION_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Single-voice narration via ElevenLabs Host voice — used for video voiceover.
 * Chunks long scripts at sentence boundaries and concatenates the MP3 buffers.
 */
export async function generateElevenLabsNarration(
  script: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");

  const chunks = splitScriptIntoChunks(script);
  console.log(`[elevenlabs] Narration — ${script.split(/\s+/).filter(Boolean).length} words, ${chunks.length} chunk(s), voice: ${HOST_VOICE}`);

  const buffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[elevenlabs] Narration chunk ${i + 1}/${chunks.length} — ${chunks[i].length} chars`);
    const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${HOST_VOICE}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: chunks[i],
        model_id: "eleven_turbo_v2_5",
        // Higher stability for consistent narration delivery (not conversational).
        voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0.10, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`ElevenLabs narration failed (${res.status}): ${err.slice(0, 200)}`);
    }
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }

  return { buffer: Buffer.concat(buffers), mimeType: "audio/mpeg" };
}
