/**
 * lib/social/slideRender.ts
 * Renders carousel slides as 1080×1350 PNGs in the "Editorial" direction the
 * user picked from rendered mockups (2026-07-20): navy gradient, gold bar +
 * kicker, tight left-aligned Anton titles with ONE gold emphasis word, a ghost
 * slide numeral top-right on point slides, a short gold rule between title and
 * body, and a vertically balanced content block (no dead bottom half).
 *
 * Text is laid out via ASS rendered by ffmpeg + libass onto a single frame
 * (same vendored-font mechanism as burnCaptions.ts — Vercel has no system
 * fonts). Placement is fully deterministic: JS word-wrap with explicit \N
 * breaks (WrapStyle 2) and \pos on every block.
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
/** ASS colours are &HAABBGGRR (BGR!). Brand gold #C9A84C → 4CA8C9. */
const GOLD = "&H004CA8C9";
const WHITE = "&H00FFFFFF";
const FONTS = join(process.cwd(), "assets", "fonts");

/** Vertical navy gradient — lighter at the top, darker at the bottom. */
const BG = `gradients=s=${W}x${H}:c0=0x152339:c1=0x0a1322:x0=${W / 2}:y0=0:x1=${W / 2}:y1=${H}:d=0.1`;

function esc(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

/**
 * Greedy word wrap with one word rendered gold. The deck model marks the
 * emphasis word with *asterisks*; if it didn't, the last word goes gold so the
 * design element is always present. `allGold` (CTA titles) skips per-word tags.
 */
function wrapTitle(
  raw: string,
  maxChars: number,
  allGold: boolean
): { text: string; lines: number } {
  const marked = raw.match(/\*([^*]+)\*/)?.[1]?.trim().split(/\s+/)[0];
  const words = esc(raw).replace(/\*/g, "").toUpperCase().split(/\s+/).filter(Boolean);
  let emphIdx = -1;
  if (!allGold && words.length) {
    const found = marked ? words.findIndex((w) => w === marked.toUpperCase()) : -1;
    emphIdx = found !== -1 ? found : words.length - 1; // fallback: last word gold
  }

  const lines: string[][] = [];
  let line: string[] = [];
  let len = 0;
  for (const w of words) {
    if (line.length && len + 1 + w.length > maxChars) {
      lines.push(line);
      line = [];
      len = 0;
    }
    line.push(w);
    len += (line.length > 1 ? 1 : 0) + w.length;
  }
  if (line.length) lines.push(line);

  let i = 0;
  const rendered = lines
    .map((ws) =>
      ws
        .map((w) => {
          const out = !allGold && i === emphIdx ? `{\\c${GOLD}}${w}{\\c${WHITE}}` : w;
          i++;
          return out;
        })
        .join(" ")
    )
    .join("\\N");

  return { text: rendered, lines: lines.length };
}

function wrapBody(text: string, maxChars: number): { text: string; lines: number } {
  const words = esc(text).split(/\s+/).filter(Boolean);
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

function buildSlide(slide: Slide, index: number, total: number) {
  const isCover = slide.kind === "cover";
  const isCta = slide.kind === "cta";

  const titleFs = isCover ? 136 : 104;
  const titleLh = isCover ? 144 : 110; // tight — Anton is a poster font
  const bodyFs = isCover ? 60 : 56;
  const bodyLh = isCover ? 86 : 80;

  const title = wrapTitle(slide.title, isCover ? 13 : 17, isCta);
  const body = slide.body?.trim() ? wrapBody(slide.body, isCover ? 30 : 36) : null;

  // Vertically balance the content block inside the zone between header and
  // footer, sitting it slightly above true centre (optically better).
  const ruleGap = 46;
  const ruleH = 6;
  const postRule = 64;
  const blockH =
    title.lines * titleLh + (body ? ruleGap + ruleH + postRule + body.lines * bodyLh : 0);
  const zoneTop = 280;
  const zoneBottom = 1210;
  const titleY = zoneTop + Math.max(0, Math.round((zoneBottom - zoneTop - blockH) * 0.4));
  const ruleY = titleY + title.lines * titleLh + ruleGap;
  const bodyY = ruleY + ruleH + postRule;

  const kicker = isCta ? "ASTON VIP · ASTON.AE" : "ASTON VIP";
  const events: string[] = [];

  // Ghost slide numeral fills the top-right on point slides.
  if (slide.kind === "point") {
    events.push(`Dialogue: 0,0:00:00.00,0:00:01.00,Ghost,,0,0,0,,{\\an9\\pos(1052,44)}${String(index).padStart(2, "0")}`);
  }
  events.push(`Dialogue: 0,0:00:00.00,0:00:01.00,Kicker,,0,0,0,,{\\an7\\pos(80,150)\\fsp6}${kicker}`);
  events.push(
    `Dialogue: 0,0:00:00.00,0:00:01.00,${isCover ? "Cover" : "Title"},,0,0,0,,{\\an7\\pos(80,${titleY})${isCta ? `\\c${GOLD}` : ""}}${title.text}`
  );
  if (body) {
    events.push(`Dialogue: 0,0:00:00.00,0:00:01.00,Body,,0,0,0,,{\\an7\\pos(80,${bodyY})}${body.text}`);
  }
  events.push(`Dialogue: 0,0:00:00.00,0:00:01.00,Footer,,0,0,0,,{\\an7\\pos(80,1272)}aston.ae`);
  events.push(
    `Dialogue: 0,0:00:00.00,0:00:01.00,Footer,,0,0,0,,{\\an9\\pos(1000,1272)\\c${GOLD}\\fsp2}${
      isCover ? `1/${total}  ·  SWIPE` : `${index}/${total}`
    }`
  );

  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // ~12% white — the translucent numeral.
    `Style: Ghost,Anton,400,&HE2FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,9,0,0,0,1`,
    `Style: Kicker,Lato,40,${GOLD},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Cover,Anton,${titleFs},${WHITE},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Title,Anton,${titleFs},${WHITE},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Body,Lato,${bodyFs},&H00F0F0F0,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Footer,Lato,34,&H00A8A8A8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
  ].join("\n");

  // Header bar always; the short gold rule only when there's a body under it.
  const boxes = [`drawbox=x=80:y=104:w=140:h=8:color=0xC9A84C:t=fill`];
  if (body) boxes.push(`drawbox=x=80:y=${ruleY}:w=110:h=${ruleH}:color=0xC9A84C:t=fill`);

  return { ass, boxes };
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
      const { ass, boxes } = buildSlide(slides[i], i + 1, slides.length);
      const assFile = `s${i}.ass`;
      await writeFile(join(dir, assFile), ass);
      await execFileAsync(
        ffmpegPath,
        [
          "-f", "lavfi", "-i", BG,
          "-vf", `${boxes.join(",")},ass=${assFile}:fontsdir=.`,
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
