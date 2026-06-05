/**
 * app/api/check-video-render/route.ts
 * GET /api/check-video-render?id=<renderId>
 *
 * Polls Shotstack for the render status of a submitted video.
 * Called by the client every ~12 seconds after /api/generate-video
 * returns a "submitted" event.
 *
 * Returns:
 *   { status: "queued"|"fetching"|"rendering"|"saving"|"done"|"failed", url?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRenderStatus }         from "@/lib/shotstack";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const renderId = req.nextUrl.searchParams.get("id");
  if (!renderId) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }

  try {
    const result = await checkRenderStatus(renderId);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[check-video-render] ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
