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

// Eleven v3 supports audio tags ([laughs], [sighs], [exhales]) for natural
// emotion. Override with ELEVENLABS_PODCAST_MODEL=eleven_multilingual_v2 if the
// account lacks v3 access (emotion tags are then disabled in the script too).
const PODCAST_MODEL = process.env.ELEVENLABS_PODCAST_MODEL || "eleven_v3";

// Music plays ONLY at the open and close. Each clip has explicit afade edges
// so fades are guaranteed — no EOS detection needed. All env-overridable.
const INTRO_SECS    = Number(process.env.PODCAST_INTRO_SECS)    || 6;
const OUTRO_SECS    = Number(process.env.PODCAST_OUTRO_SECS)    || 10;
const INTRO_VOLUME  = Number(process.env.PODCAST_INTRO_VOLUME)  || 0.20;
const OUTRO_VOLUME  = Number(process.env.PODCAST_OUTRO_VOLUME)  || 0.16;
// Target integrated loudness (LUFS) every voice turn is normalised to. Lower
// (more negative) = quieter; -14 is the streaming/podcast standard, -12 is louder.
const VOICE_LUFS    = Number(process.env.PODCAST_VOICE_LUFS)    || -14;
// The expert (Adam) is a deeper voice and sounds quieter than the host (Liz)
// at the same measured loudness, so target it a few LUFS hotter. loudnorm's
// true-peak limiting keeps it from clipping. Tunable via PODCAST_EXPERT_LUFS.
const EXPERT_LUFS   = Number(process.env.PODCAST_EXPERT_LUFS)   || (VOICE_LUFS + 3);

// ── TTS pronunciation fixes ───────────────────────────────────
// Phonetic respellings applied ONLY to the text sent to the voice model, so
// transcripts and on-screen brand text stay correct. Works on every model
// (including Eleven v3, which does not support <phoneme> SSML tags).
// "Aston" was read as "As-TON" (rhyming with "on"); respell so it lands as
// "As-tin". Tune without code via PODCAST_SAYAS_ASTON.
const SAYAS_ASTON = process.env.PODCAST_SAYAS_ASTON || "Asstin";
const PRONUNCIATION: Array<[RegExp, string]> = [
  [/\bAston\b/gi, SAYAS_ASTON],
];
export function applyTtsPronunciation(text: string): string {
  return PRONUNCIATION.reduce((s, [re, rep]) => s.replace(re, rep), text);
}

/** Synthesize one dialogue turn via ElevenLabs. */
async function synthesizeTurn(turn: DialogueTurn, apiKey: string): Promise<Buffer> {
  const voiceId = turn.speaker === "host" ? HOST_VOICE : EXPERT_VOICE;
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: applyTtsPronunciation(turn.text),
      model_id: PODCAST_MODEL,
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

    // 2. Concat all turns into one uniform speech track (clean — no music here).
    //    Loudness-normalise EVERY turn to the same target first, so the two
    //    voices sit at equal volume (Rachel/host is inherently louder than
    //    Adam/expert) and the whole episode is consistently loud. -14 LUFS is
    //    the streaming/podcast standard; override with PODCAST_VOICE_LUFS.
    const speechFile = join(dir, "speech.mp3");
    const speechInputs = turnFiles.flatMap((f) => ["-i", f]);
    const speechFilter =
      turnFiles.map((_, i) => {
        const target = turns[i]?.speaker === "expert" ? EXPERT_LUFS : VOICE_LUFS;
        return `[${i}:a]loudnorm=I=${target}:TP=-1.5:LRA=11[n${i}]`;
      }).join(";") + ";" +
      turnFiles.map((_, i) => `[n${i}]`).join("") +
      `concat=n=${turnFiles.length}:v=0:a=1[out]`;
    await ffmpeg(["-y", ...speechInputs, "-filter_complex", speechFilter, "-map", "[out]",
      "-ar", "44100", "-ac", "2", "-b:a", "128k", speechFile]);

    // 3. Overlay music: fade out under the speech at the start, fade back in
    //    under the speech at the end. Uses adelay + amix so the music and speech
    //    overlap smoothly — no hard cuts.
    //
    //    Timeline:
    //      0s ─── music plays at INTRO_VOLUME, fades out over INTRO_SECS ───┐
    //             speech starts at 0s (under the fading music)               │
    //             ...entire conversation...                                  │
    //      end ── music fades in over OUTRO_SECS at OUTRO_VOLUME ── fades out
    //
    const musicUrl = process.env.BACKGROUND_MUSIC_URL;
    if (musicUrl) {
      try {
        const musicRes = await fetch(musicUrl, { signal: AbortSignal.timeout(20_000) });
        if (musicRes.ok) {
          const musicFile = join(dir, "music.mp3");
          await writeFile(musicFile, Buffer.from(await musicRes.arrayBuffer()));

          // Get the speech duration using ffmpeg (not ffprobe, which ffmpeg-static
          // doesn't ship). ffmpeg prints "time=HH:MM:SS.ss" in its stderr when
          // transcoding to null — we parse the last occurrence.
          let speechDuration = 300; // fallback
          try {
            const { stderr } = await execFileAsync(ffmpegPath!, [
              "-i", speechFile, "-f", "null", "-",
            ], { maxBuffer: 1024 * 1024 });
            const timeMatch = stderr.match(/time=(\d+):(\d+):([\d.]+)/g);
            if (timeMatch) {
              const last = timeMatch[timeMatch.length - 1];
              const [, h, m, s] = last.match(/time=(\d+):(\d+):([\d.]+)/)!;
              speechDuration = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
            }
          } catch {
            console.warn("[podcastAudio] could not probe speech duration — using fallback 300s");
          }

          // Outro music starts this many seconds before the speech ends, so it
          // fades in under the final words rather than starting after silence.
          const outroStartSec = Math.max(0, speechDuration - OUTRO_SECS);

          const episodeFile = join(dir, "episode.mp3");
          await ffmpeg([
            "-y",
            "-i", speechFile,                      // 0: speech
            "-stream_loop", "-1", "-i", musicFile, // 1: intro music
            "-stream_loop", "-1", "-i", musicFile, // 2: outro music
            "-filter_complex",
            // Intro: trim to INTRO_SECS, fade in quickly, fade out gradually
            // over the full duration so it smoothly disappears under the speech.
            `[1:a]atrim=0:${INTRO_SECS},asetpts=PTS-STARTPTS,` +
            `aformat=sample_rates=44100:channel_layouts=stereo,` +
            `volume=${INTRO_VOLUME},` +
            `afade=t=in:st=0:d=1.5,afade=t=out:st=0:d=${INTRO_SECS}[intro];` +
            // Outro: trim to OUTRO_SECS, delay to start near the end of speech,
            // fade in gradually, then fade out at the very end.
            `[2:a]atrim=0:${OUTRO_SECS},asetpts=PTS-STARTPTS,` +
            `aformat=sample_rates=44100:channel_layouts=stereo,` +
            `volume=${OUTRO_VOLUME},` +
            `afade=t=in:st=0:d=${Math.min(4, OUTRO_SECS)},` +
            `afade=t=out:st=${Math.max(0, OUTRO_SECS - 4)}:d=4,` +
            `adelay=${Math.round(outroStartSec * 1000)}|${Math.round(outroStartSec * 1000)}[outro];` +
            // Mix all three together (overlay, not concat).
            `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[sp];` +
            `[sp][intro][outro]amix=inputs=3:duration=longest:dropout_transition=0,` +
            // Final loudnorm so the mixed result hits podcast-standard loudness.
            `loudnorm=I=${VOICE_LUFS}:TP=-1.5:LRA=11[out]`,
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
 * Chunks long scripts at sentence boundaries, then merges with ffmpeg so the
 * output is a single valid MP3 (raw Buffer.concat embeds ID3 headers mid-stream
 * which ffprobe rejects with "Failed to find two consecutive MPEG audio frames").
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
        text: applyTtsPronunciation(chunks[i]),
        model_id: "eleven_turbo_v2_5",
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

  // Single chunk — no merge needed, the buffer is already a valid MP3.
  if (buffers.length === 1) {
    return { buffer: buffers[0], mimeType: "audio/mpeg" };
  }

  // Multiple chunks: merge with ffmpeg so the result is a single valid MP3.
  // Raw Buffer.concat would embed ID3 headers mid-stream, breaking ffprobe.
  const dir = await mkdtemp(join(tmpdir(), "narration-"));
  try {
    const chunkFiles: string[] = [];
    for (let i = 0; i < buffers.length; i++) {
      const f = join(dir, `chunk-${String(i).padStart(3, "0")}.mp3`);
      await writeFile(f, buffers[i]);
      chunkFiles.push(f);
    }
    const outFile = join(dir, "narration.mp3");
    const inputs = chunkFiles.flatMap((f) => ["-i", f]);
    const filter = chunkFiles.map((_, i) => `[${i}:a]`).join("") +
      `concat=n=${chunkFiles.length}:v=0:a=1[out]`;
    await ffmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "[out]",
      "-ar", "44100", "-ac", "2", "-b:a", "128k", outFile]);
    return { buffer: await readFile(outFile), mimeType: "audio/mpeg" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
