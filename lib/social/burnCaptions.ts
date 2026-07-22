/**
 * lib/social/burnCaptions.ts
 * Burns word-synced captions onto a reel MP4 with ffmpeg + libass.
 *
 * The word timings come from ElevenLabs (generateSpeechWithTimestamps), and the
 * avatar is lip-synced to that same audio, so the captions land exactly on the
 * spoken words. Reels are watched on mute, so this is what makes them work.
 *
 * A font is bundled (assets/fonts/Anton-Regular.ttf) and passed via fontsdir so
 * rendering is deterministic — Vercel's runtime has no system fonts, so relying
 * on fontconfig would render nothing.
 *
 * Best-effort by contract: any failure throws, and the caller keeps the
 * uncaptioned video rather than losing the (paid) render.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, copyFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegPath from "ffmpeg-static";
import type { WordTiming } from "@/lib/elevenlabs";

const execFileAsync = promisify(execFile);

const FONT_NAME = "Anton";
const FONT_FILE = "Anton-Regular.ttf";
const FONT_SRC = join(process.cwd(), "assets", "fonts", FONT_FILE);

/** Reel captions read best in short bursts — a few words at a time. */
const MAX_WORDS_PER_CUE = 3;
const MAX_CUE_SECONDS = 1.6;

interface Cue {
  start: number;
  end: number;
  text: string;
}

function buildCues(words: WordTiming[]): Cue[] {
  const cues: Cue[] = [];
  let group: WordTiming[] = [];

  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    const end = Math.max(group[group.length - 1].end, start + 0.3);
    cues.push({ start, end, text: group.map((w) => w.word).join(" ") });
    group = [];
  };

  for (const w of words) {
    if (group.length && (group.length >= MAX_WORDS_PER_CUE || w.end - group[0].start > MAX_CUE_SECONDS)) {
      flush();
    }
    group.push(w);
  }
  flush();
  return cues;
}

/** ASS timestamp: H:MM:SS.cc (centiseconds). */
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${h}:${p(m)}:${p(s)}.${p(c)}`;
}

function escapeAss(text: string): string {
  // Curly braces are ASS override blocks; newlines must be explicit.
  return text.replace(/[{}]/g, "").replace(/\r?\n/g, " ").toUpperCase();
}

/**
 * Build an ASS subtitle document sized for a 1080x1920 vertical reel. Big bold
 * Anton, white with a heavy black outline, centred in the lower third (clear of
 * the platform's own UI overlays).
 */
function buildAss(cues: Cue[]): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // White text, black outline, subtle shadow, bottom-centre (2), lifted 300px.
    `Style: Reel,${FONT_NAME},96,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,2,0,1,6,3,2,80,80,300,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = cues
    .map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Reel,,0,0,0,,${escapeAss(c.text)}`)
    .join("\n");

  return `${header}\n${events}\n`;
}

/**
 * Returns a new MP4 buffer with captions burned in. Throws on any failure — the
 * caller is expected to fall back to the original video.
 */
export async function burnCaptions(videoBuffer: Buffer, words: WordTiming[]): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found");
  const cues = buildCues(words);
  if (!cues.length) throw new Error("no caption cues to burn");

  const dir = await mkdtemp(join(tmpdir(), "reelcap-"));
  try {
    await writeFile(join(dir, "in.mp4"), videoBuffer);
    await writeFile(join(dir, "cap.ass"), buildAss(cues));
    await copyFile(FONT_SRC, join(dir, FONT_FILE)); // fontsdir=. finds it here

    // Run inside the temp dir so all filter paths are simple relative names
    // (avoids ffmpeg filtergraph escaping of absolute paths).
    await execFileAsync(
      ffmpegPath,
      ["-i", "in.mp4", "-vf", "ass=cap.ass:fontsdir=.", "-c:a", "copy", "-y", "out.mp4"],
      { cwd: dir, timeout: 180_000, maxBuffer: 1 << 26 }
    );

    const out = await readFile(join(dir, "out.mp4"));
    if (out.length < 1024) throw new Error("ffmpeg produced an empty output");
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
