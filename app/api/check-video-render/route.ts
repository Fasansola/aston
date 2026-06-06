/**
 * app/api/check-video-render/route.ts
 * GET /api/check-video-render?id=<renderId>&bucket=<bucketName>
 *
 * Polls Remotion Lambda for the render status of a submitted video.
 * Called by the client every ~10 seconds after /api/generate-video
 * returns a "submitted" event.
 *
 * Returns:
 *   { status: "rendering"|"done"|"error", progress: number, url?: string, error?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { pollRemotionRender }        from "@/lib/remotionRenderer";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const renderId   = req.nextUrl.searchParams.get("id");
  const bucketName = req.nextUrl.searchParams.get("bucket");

  if (!renderId)   return NextResponse.json({ error: "id is required."     }, { status: 400 });
  if (!bucketName) return NextResponse.json({ error: "bucket is required." }, { status: 400 });

  try {
    const result = await pollRemotionRender(renderId, bucketName);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[check-video-render] ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
