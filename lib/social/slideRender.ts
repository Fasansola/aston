/**
 * lib/social/slideRender.ts
 * Renders a carousel to 1080×1350 PNGs in the "Editorial" direction:
 *
 *   [ intro image + navy title banner ]  ← GPT Image 2 photo, brand navy band
 *   [ point slides … ]                    ← navy gradient, gold emphasis word
 *   [ contact slide ]                     ← logo + contact info (video end screen)
 *
 * Text is laid out via ASS rendered by ffmpeg + libass onto a single frame (the
 * vendored-font mechanism from burnCaptions.ts — Vercel has no system fonts).
 * Placement is deterministic: JS word-wrap with explicit \N (WrapStyle 2) and
 * \pos on every block.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, copyFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import ffmpegPath from "ffmpeg-static";
import type { Slide } from "@/lib/social/slideDeck";
import { CONTACT } from "@/lib/social/persona";

const execFileAsync = promisify(execFile);

const W = 1080;
const H = 1350;
/** ASS colours are &HAABBGGRR (BGR!). Brand gold #C9A84C → 4CA8C9. */
const GOLD = "&H004CA8C9";
const WHITE = "&H00FFFFFF";
/** Navy used for text sitting on the gold footer band. */
const NAVY_TEXT = "&H00122036";
const FONTS = join(process.cwd(), "assets", "fonts");

/** Faint grid texture. Needs rgb24 first (drawgrid rejects some pixel formats). */
const GRID = "format=rgb24,drawgrid=width=54:height=54:thickness=1:color=0xffffff@0.028";
/** Footer-text style, shared by every slide (navy, sits on the gold band). */
const FNAV_STYLE = `Style: Fnav,Lato,34,${NAVY_TEXT},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`;
const BAR_Y = 1216;
const BAND_Y = 1286;

/**
 * The shared bottom system: swipe-progress bars (one per slide, active = gold)
 * and the solid gold footer band with the wordmark + page number. `withBars`
 * is off for the intro, whose band is busier.
 */
function footerSystem(position: number, total: number, withBars: boolean): { boxes: string[]; events: string[] } {
  const boxes: string[] = [];
  if (withBars) {
    const barW = 70;
    const gap = 86;
    for (let i = 0; i < total; i++) {
      const x = 80 + i * gap;
      if (x + barW > 1000) break;
      boxes.push(`drawbox=x=${x}:y=${BAR_Y}:w=${barW}:h=8:color=${i === position - 1 ? "0xC9A84C" : "0xffffff@0.16"}:t=fill`);
    }
  }
  boxes.push(`drawbox=x=0:y=${BAND_Y}:w=${W}:h=64:color=0xC9A84C:t=fill`);
  const events = [
    `Dialogue: 0,0:00:00.00,0:00:01.00,Fnav,,0,0,0,,{\\an4\\pos(80,1318)\\fsp3}ASTON VIP`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Fnav,,0,0,0,,{\\an6\\pos(1000,1318)}${position} / ${total}`,
  ];
  return { boxes, events };
}

/** Vertical navy gradient — lighter at the top, darker at the bottom. */
const BG = `gradients=s=${W}x${H}:c0=0x152339:c1=0x0a1322:x0=${W / 2}:y0=0:x1=${W / 2}:y1=${H}:d=0.1`;
/** Intro photo occupies the top; the navy band below holds the title + subtitle. */
const IMG_H = 760;

function esc(text: string): string {
  return text.replace(/[{}]/g, "").replace(/\r?\n/g, " ");
}

const ASS_HEAD = [
  "[Script Info]",
  "ScriptType: v4.00+",
  `PlayResX: ${W}`,
  `PlayResY: ${H}`,
  "WrapStyle: 2",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
].join("\n");

const EVENTS_HEAD = ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"].join("\n");

/** Greedy title wrap; one word rendered gold. `allGold` skips per-word tags. */
function wrapTitle(raw: string, maxChars: number, allGold = false): { text: string; lines: number } {
  const marked = raw.match(/\*([^*]+)\*/)?.[1]?.trim().split(/\s+/)[0];
  const words = esc(raw).replace(/\*/g, "").toUpperCase().split(/\s+/).filter(Boolean);
  let emphIdx = -1;
  if (!allGold && words.length) {
    const found = marked ? words.findIndex((w) => w === marked.toUpperCase()) : -1;
    emphIdx = found !== -1 ? found : words.length - 1;
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
  const text = lines
    .map((ws) => ws.map((w) => (i++ === emphIdx ? `{\\c${GOLD}}${w}{\\c${WHITE}}` : w)).join(" "))
    .join("\\N");
  return { text, lines: lines.length };
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

/** Build the ASS + ffmpeg drawbox list for one point slide. */
function buildPoint(slide: Slide, position: number, total: number) {
  const titleLh = 110;
  const bodyLh = 64;

  const title = wrapTitle(slide.title, 17);
  const body = slide.body?.trim() ? wrapBody(slide.body, 36) : null;

  const titleY = 440;
  // Body sits in a card panel below the title; the card sizes to the copy.
  const cardTop = titleY + title.lines * titleLh + 46;
  const cardPad = 44;
  const cardH = body ? body.lines * bodyLh + cardPad * 2 : 0;

  const events = [
    `Dialogue: 0,0:00:00.00,0:00:01.00,Num,,0,0,0,,{\\an9\\pos(1045,50)}${String(position).padStart(2, "0")}`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Kicker,,0,0,0,,{\\an7\\pos(80,150)\\fsp6}ASTON VIP`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Title,,0,0,0,,{\\an7\\pos(80,${titleY})}${title.text}`,
    ...(body ? [`Dialogue: 0,0:00:00.00,0:00:01.00,Body,,0,0,0,,{\\an7\\pos(112,${cardTop + cardPad})}${body.text}`] : []),
  ];

  const styles = [
    // Hollow gold numeral: invisible fill (alpha FF), gold outline.
    `Style: Num,Anton,290,&HFF000000,&H000000FF,${GOLD},&H00000000,0,0,0,0,100,100,0,0,1,4,0,9,0,0,0,1`,
    `Style: Kicker,Lato,40,${GOLD},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Title,Anton,96,${WHITE},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Body,Lato,50,&H00ECECEC,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    FNAV_STYLE,
  ];

  const boxes = [`drawbox=x=80:y=104:w=140:h=8:color=0xC9A84C:t=fill`];
  if (body) {
    boxes.push(`drawbox=x=60:y=${cardTop}:w=960:h=${cardH}:color=0xffffff@0.04:t=fill`);
    boxes.push(`drawbox=x=60:y=${cardTop}:w=6:h=${cardH}:color=0xC9A84C:t=fill`);
  }
  const footer = footerSystem(position, total, true);

  return { ass: [ASS_HEAD, ...styles, EVENTS_HEAD, ...events, ...footer.events].join("\n"), boxes: [...boxes, ...footer.boxes] };
}

/** Intro slide ASS — kicker + topic title + a "what it covers" subtitle. */
function buildIntroAss(hook: string, subtitle: string, total: number) {
  const titleLh = 92;
  const title = wrapTitle(hook, 19);
  const sub = subtitle.trim() ? wrapBody(esc(subtitle), 42) : null;

  const kickerY = IMG_H + 42; // 802
  const titleY = IMG_H + 100; // 860
  const subY = titleY + title.lines * titleLh + 34;

  const styles = [
    `Style: Kicker,Lato,40,${GOLD},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Title,Anton,80,${WHITE},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    `Style: Sub,Lato,40,&H00D8D8D8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    FNAV_STYLE,
  ];
  const footer = footerSystem(1, total, false);
  const events = [
    `Dialogue: 0,0:00:00.00,0:00:01.00,Kicker,,0,0,0,,{\\an7\\pos(80,${kickerY})\\fsp6}ASTON VIP`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Title,,0,0,0,,{\\an7\\pos(80,${titleY})}${title.text}`,
    ...(sub ? [`Dialogue: 0,0:00:00.00,0:00:01.00,Sub,,0,0,0,,{\\an7\\pos(80,${subY})}${sub.text}`] : []),
    ...footer.events,
  ];
  return { ass: [ASS_HEAD, ...styles, EVENTS_HEAD, ...events].join("\n"), boxes: footer.boxes };
}

/** Contact slide ASS — centred block ported from the video end screen. */
function buildContactAss(total: number) {
  const styles = [
    `Style: Kicker,Lato,38,${GOLD},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1`,
    `Style: Lead,Anton,64,${WHITE},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1`,
    `Style: Label,Lato,32,${GOLD},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1`,
    `Style: Value,Lato,50,${WHITE},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1`,
    `Style: Site,Anton,72,${GOLD},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,8,0,0,0,1`,
    FNAV_STYLE,
  ];
  const footer = footerSystem(total, total, true);
  const events = [
    `Dialogue: 0,0:00:00.00,0:00:01.00,Kicker,,0,0,0,,{\\an8\\pos(540,506)\\fsp8}${CONTACT.tagline.toUpperCase()}`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Lead,,0,0,0,,{\\an8\\pos(540,572)}${esc(CONTACT.cta).toUpperCase()}`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Label,,0,0,0,,{\\an8\\pos(540,724)\\fsp4}${CONTACT.whatsappLabel.toUpperCase()}`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Value,,0,0,0,,{\\an8\\pos(540,772)}${esc(CONTACT.whatsapp)}`,
    `Dialogue: 0,0:00:00.00,0:00:01.00,Site,,0,0,0,,{\\an8\\pos(540,892)}${CONTACT.site}`,
    ...footer.events,
  ];
  // Divider rule under the logo, then the shared footer boxes.
  const boxes = [`drawbox=x=500:y=470:w=80:h=4:color=0xC9A84C:t=fill`, ...footer.boxes];
  return { ass: [ASS_HEAD, ...styles, EVENTS_HEAD, ...events].join("\n"), boxes };
}

/**
 * Render an entire carousel: intro image slide → point slides → contact slide.
 * `introImage` and `logo` are optional — each degrades to a clean text-only
 * treatment if absent so a carousel is never blocked on an asset.
 */
export async function renderCarousel(input: {
  hook: string;
  subtitle?: string;
  slides: Slide[];
  introImage?: Buffer;
  logo?: Buffer;
}): Promise<Buffer[]> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary not found");
  const total = input.slides.length + 2;
  const dir = await mkdtemp(join(tmpdir(), "carousel-"));

  const run = async (args: string[], outName: string): Promise<Buffer> => {
    await execFileAsync(ffmpegPath!, args, { cwd: dir, timeout: 60_000, maxBuffer: 1 << 26 });
    const png = await readFile(join(dir, outName));
    if (png.length < 1024) throw new Error(`${outName} rendered empty`);
    return png;
  };

  try {
    await copyFile(join(FONTS, "Anton-Regular.ttf"), join(dir, "Anton-Regular.ttf"));
    await copyFile(join(FONTS, "Lato-Regular.ttf"), join(dir, "Lato-Regular.ttf"));

    const out: Buffer[] = [];

    // ── Intro slide ────────────────────────────────────────────
    // Two passes on purpose: a first pass scales/crops the photo, a second
    // composites with a SINGLE filterchain (no ';', no named pad labels). The
    // multi-chain filter_complex form parses on some ffmpeg builds but is
    // rejected by ffmpeg 7.0.2 on Vercel, so we avoid it entirely.
    const intro = buildIntroAss(input.hook, input.subtitle ?? "", total);
    await writeFile(join(dir, "intro.ass"), intro.ass);
    if (input.introImage) {
      await writeFile(join(dir, "intro_src.png"), input.introImage);
      await execFileAsync(
        ffmpegPath,
        ["-i", "intro_src.png", "-vf", `scale=${W}:${IMG_H}:force_original_aspect_ratio=increase,crop=${W}:${IMG_H}`, "-frames:v", "1", "-y", "photo.png"],
        { cwd: dir, timeout: 60_000, maxBuffer: 1 << 26 }
      );
      out.push(
        await run(
          [
            "-f", "lavfi", "-i", BG,
            "-i", "photo.png",
            "-filter_complex",
            `[0:v][1:v]overlay=0:0,drawbox=x=0:y=${IMG_H}:w=${W}:h=4:color=0xC9A84C:t=fill,${intro.boxes.join(",")},ass=intro.ass:fontsdir=.`,
            "-frames:v", "1", "-y", "intro.png",
          ],
          "intro.png"
        )
      );
    } else {
      // No photo — fall back to a navy title slide (gold bar + title in the band).
      out.push(
        await run(
          ["-f", "lavfi", "-i", BG, "-vf", `drawbox=x=80:y=${IMG_H - 20}:w=140:h=8:color=0xC9A84C:t=fill,${intro.boxes.join(",")},ass=intro.ass:fontsdir=.`, "-frames:v", "1", "-y", "intro.png"],
          "intro.png"
        )
      );
    }

    // ── Point slides ───────────────────────────────────────────
    for (let i = 0; i < input.slides.length; i++) {
      const { ass, boxes } = buildPoint(input.slides[i], i + 2, total);
      await writeFile(join(dir, `p${i}.ass`), ass);
      out.push(
        await run(
          ["-f", "lavfi", "-i", BG, "-vf", `${GRID},${boxes.join(",")},ass=p${i}.ass:fontsdir=.`, "-frames:v", "1", "-y", `p${i}.png`],
          `p${i}.png`
        )
      );
    }

    // ── Contact slide ──────────────────────────────────────────
    const ct = buildContactAss(total);
    await writeFile(join(dir, "contact.ass"), ct.ass);
    const ctBoxes = ct.boxes.join(",");

    let contact: Buffer | undefined;
    if (input.logo) {
      // Best-effort: if the logo can't be decoded (e.g. an SVG — ffmpeg has no
      // SVG decoder) fall through to the text-only contact slide rather than
      // failing the whole carousel.
      try {
        await writeFile(join(dir, "logo.png"), input.logo);
        await execFileAsync(
          ffmpegPath,
          ["-i", "logo.png", "-vf", "scale=-1:150", "-frames:v", "1", "-y", "logo150.png"],
          { cwd: dir, timeout: 60_000, maxBuffer: 1 << 26 }
        );
        contact = await run(
          [
            "-f", "lavfi", "-i", BG,
            "-i", "logo150.png",
            "-filter_complex",
            `[0:v][1:v]overlay=(W-w)/2:250,${GRID},${ctBoxes},ass=contact.ass:fontsdir=.`,
            "-frames:v", "1", "-y", "contact.png",
          ],
          "contact.png"
        );
      } catch (e) {
        console.warn(`[slideRender] contact logo composite failed, using text-only: ${e}`);
      }
    }
    if (!contact) {
      contact = await run(
        ["-f", "lavfi", "-i", BG, "-vf", `${GRID},${ctBoxes},ass=contact.ass:fontsdir=.`, "-frames:v", "1", "-y", "contact_t.png"],
        "contact_t.png"
      );
    }
    out.push(contact);

    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
