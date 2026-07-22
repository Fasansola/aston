/**
 * app/api/social/slides/route.ts
 * POST /api/social/slides — generate a text-on-image carousel.
 *
 * Body: { topic, angle?, slideCount? (5–7) }
 * Flow: AI writes the slide copy → each slide is rendered to a 1080×1350 PNG
 * (ffmpeg + vendored fonts, deterministic text) → uploaded to S3 → returns
 * { deck, imageUrls } for the studio to preview and share.
 */

import { NextRequest, NextResponse } from "next/server";
import { generateSlideDeck } from "@/lib/social/slideDeck";
import { renderSlideImages } from "@/lib/social/slideRender";
import { uploadAssetToS3 } from "@/lib/sceneImageS3";

export const maxDuration = 300;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
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

    const pngs = await renderSlideImages(deck.slides);

    const batch = `carousel_${Date.now()}`;
    const imageUrls = await Promise.all(
      pngs.map((png, i) => uploadAssetToS3(png, `${batch}-${i + 1}.png`, "image/png", "slides"))
    );

    console.log(`[social/slides] "${topic}" → ${deck.slides.length} slides rendered + uploaded`);
    return NextResponse.json({ deck, imageUrls });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[social/slides] failed for "${topic}": ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
