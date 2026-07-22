/**
 * lib/social/slideRender.ts
 * Renders carousel slides as 1080×1350 PNGs: Aston navy background, gold
 * accents, Anton titles, Lato body — text laid out via an ASS subtitle rendered
 * by ffmpeg + libass onto a single frame (the same vendored-font mechanism as
 * burnCaptions.ts, so it works on Vercel where there are no system fonts).
 *
 * Text placement is fully deterministic: we word-wrap in JS with explicit \N
 * breaks (WrapStyle 2) and position every block with \pos, so nothing depends
 * on libass's own wrapping or collision behaviour.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, copyFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegPath from "ffmpeg-static";
import type { Slide } from "@/lib/social/slideDeck";

const execFileAsync = promisify(execFile);

const W = 1080;
const H = 1350;
const NAVY = "0x0f1a2e";
/** ASS colours are &HAABBGGRR (BGR!). Brand gold #C9A84C → 4CA8C9. */
const GOLD_ASS = "&H004CA8C9";
const FONTS = join(process.cwd(), "assets", "fonts");

/** Greedy word wrap with explicit ASS line breaks. */
function wrap(text: string, maxChars: number): { text: string; lines: number } {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return { text: lines.join("\\N"), lines: lines.length };
}

function esc(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

/** One Dialogue event pinned at (x,y), top-left anchored. */
function ev(style: string, x: number, y: number, text: string, extraTags = ""): string {
  return `Dialogue: 0,0:00:00.00,0:00:01.00,${style},,0,0,0,,{\\an7\\pos(${x},${y})${extraTags}}${text}`;
}

function buildAss(slide: Slide, index: number, total: number): string {
  const events: string[] = [];
  const isCover = slide.kind === "cover";
  const titleSize = isCover ? 120 : 96;
  const titleLh = isCover ? 138 : 112; // line height per wrapped title line
  const title = wrap(esc(slide.title).toUpperCase(), isCover ? 15 : 18);

  // Kicker row (the gold bar above it is drawn by ffmpeg's drawbox).
  const kicker = isCover ? "ASTON VIP" : slide.kind === "cta" ? "ASTON VIP · ASTON.AE" : `ASTON VIP · ${String(index).padStart(2, "0")}`;
  events.push(ev("Kicker", 80, 150, kicker, "\\fsp6"));

  // Title block from y=250; CTA titles go gold.
  const titleY = 250;
  events.push(ev(isCover ? "Cover" : "Title", 80, titleY, title.text, slide.kind === "cta" ? `\\c${GOLD_ASS}` : ""));

  // Body sits below however many lines the title wrapped to.
  if (slide.body?.trim()) {
    const body = wrap(esc(slide.body), 38);
    const bodyY = titleY + title.lines * titleLh + 70;
    events.push(ev("Body", 80, bodyY, body.text));
  }

  // Footer row.
  events.push(ev("Footer", 80, 1272, "aston.ae"));
  events.push(
    `Dialogue: 0,0:00:00.00,0:00:01.00,Footer,,0,0,0,,{\\an9\\pos(1000,1272)\\c${GOLD_ASS}}${
      isCover ? `1/${total}  SWIPE` : `${index}/${total}`
    }`
  );

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Kicker,Lato,40,${GOLD_ASS},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    "Style: Cover,Anton,120,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Title,Anton,96,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Body,Lato,52,&H00E6E6E6,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "Style: Footer,Lato,34,&H009A9A9A,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
  ].join("\n");
}

/** Render every slide of a deck to PNG buffers, in order. */
export async function renderSlideImages(slides: Slide[]): Promise<Buffer[]> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found");
  const dir = await mkdtemp(join(tmpdir(), "slides-"));
  try {
    await copyFile(join(FONTS, "Anton-Regular.ttf"), join(dir, "Anton-Regular.ttf"));
    await copyFile(join(FONTS, "Lato-Regular.ttf"), join(dir, "Lato-Regular.ttf"));

    const out: Buffer[] = [];
    for (let i = 0; i < slides.length; i++) {
      const assFile = `s${i}.ass`;
      await writeFile(join(dir, assFile), buildAss(slides[i], i + 1, slides.length));
      await execFileAsync(
        ffmpegPath,
        [
          "-f", "lavfi", "-i", `color=c=${NAVY}:s=${W}x${H}:d=0.1`,
          // Gold accent bar top-left, then the text layer.
          "-vf", `drawbox=x=80:y=104:w=140:h=8:color=0xC9A84C:t=fill,ass=${assFile}:fontsdir=.`,
          "-frames:v", "1", "-y", `s${i}.png`,
        ],
        { cwd: dir, timeout: 60_000, maxBuffer: 1 << 26 }
      );
      const png = await readFile(join(dir, `s${i}.png`));
      if (png.length < 1024) throw new Error(`slide ${i + 1} rendered empty`);
      out.push(png);
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
