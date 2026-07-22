/**
 * app/api/social/slides/route.ts
 * POST /api/social/slides — generate a text-on-image carousel.
 *
 * Body: { topic, angle?, slideCount? (content slides, 4–8) }
 * Flow: AI writes the deck (intro hook + image brief + point slides) → GPT
 * Image 2 renders the intro photo → each slide is rendered to a 1080×1350 PNG
 * (intro banner, point slides, contact slide) → uploaded to S3.
 * Returns { deck, imageUrls } — imageUrls in swipe order (intro, points, contact).
 */

import { NextRequest, NextResponse } from "next/server";
import { generateSlideDeck, generateIntroImage } from "@/lib/social/slideDeck";
import { renderCarousel } from "@/lib/social/slideRender";
import { uploadAssetToS3 } from "@/lib/sceneImageS3";

export const maxDuration = 300;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

/** True if the buffer is a raster image ffmpeg can decode (PNG/JPEG/GIF/WebP). */
function isRasterImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const gif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
  const webp = b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  return png || jpg || gif || webp;
}

/**
 * Fetch the brand logo for the contact slide (best-effort — it renders text-only
 * without one). Prefers ASTON_LOGO_PNG_URL; the default ASTON_LOGO_URL is an SVG
 * which ffmpeg cannot decode, so a non-raster asset is skipped.
 */
async function fetchLogo(): Promise<Buffer | undefined> {
  const url = process.env.ASTON_LOGO_PNG_URL || process.env.ASTON_LOGO_URL;
  if (!url) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isRasterImage(buf)) {
      console.warn("[social/slides] logo is not a raster image (ffmpeg can't decode SVG) — contact slide will be text-only. Set ASTON_LOGO_PNG_URL to a PNG/JPG.");
      return undefined;
    }
    return buf;
  } catch {
    return undefined;
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) return NextResponse.json({ error: "topic is required" }, { status: 400 });

  try {
    const deck = await generateSlideDeck({
      topic,
      angle: typeof body.angle === "string" ? body.angle : undefined,
      slideCount: typeof body.slideCount === "number" ? body.slideCount : undefined,
    });

    // Intro photo and logo run alongside each other; a failed photo degrades to
    // a navy title slide rather than failing the whole carousel.
    const [introImage, logo] = await Promise.all([
      generateIntroImage(deck.imageBrief).catch((e) => {
        console.warn(`[social/slides] intro image failed, using text intro: ${e}`);
        return undefined;
      }),
      fetchLogo(),
    ]);

    const pngs = await renderCarousel({ hook: deck.hook, slides: deck.slides, introImage, logo });

    const batch = `carousel_${Date.now()}`;
    const imageUrls = await Promise.all(
      pngs.map((png, i) => uploadAssetToS3(png, `${batch}-${i + 1}.png`, "image/png", "slides"))
    );

    console.log(
      `[social/slides] "${topic}" → ${pngs.length} images (intro${introImage ? "+photo" : " text"}, ${deck.slides.length} points, contact)`
    );
    return NextResponse.json({ deck, imageUrls });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[social/slides] failed for "${topic}": ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
