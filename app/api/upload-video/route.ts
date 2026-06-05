/**
 * app/api/upload-video/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/upload-video
 *
 * Accepts either:
 *   videoUrl   — Shotstack MP4 URL (fetched server-side, then uploaded)
 *   videoBase64 — legacy base64 encoded video (backward compat)
 *
 * Uploads to YouTube (unlisted) and patches the WP post's ACF video_url.
 */

import { NextRequest, NextResponse } from "next/server";
import { uploadToYouTube, updatePostVideoUrl } from "@/lib/video";

export const maxDuration = 180;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const { postId, title, videoUrl, videoBase64 } = body as {
    postId?: number;
    title?: string;
    videoUrl?: string;
    videoBase64?: string;
  };

  if (!postId || typeof postId !== "number")
    return NextResponse.json({ error: "postId is required." }, { status: 400 });
  if (!title?.trim())
    return NextResponse.json({ error: "title is required." }, { status: 400 });
  if (!videoUrl && !videoBase64)
    return NextResponse.json({ error: "videoUrl or videoBase64 is required." }, { status: 400 });

  const missingVars = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]
    .filter((k) => !process.env[k]);
  if (missingVars.length > 0)
    return NextResponse.json({ error: `YouTube not configured. Missing: ${missingVars.join(", ")}` }, { status: 503 });

  try {
    let videoBuffer: Buffer;

    if (videoUrl) {
      // Fetch the MP3 from Shotstack's CDN
      console.log(`[upload-video] Fetching video from Shotstack: ${videoUrl}`);
      const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Failed to fetch video from URL: ${res.status} ${res.statusText}`);
      videoBuffer = Buffer.from(await res.arrayBuffer());
    } else {
      videoBuffer = Buffer.from(videoBase64!, "base64");
    }

    console.log(`[upload-video] Uploading ${videoBuffer.length} bytes to YouTube…`);
    const description = `This video accompanies the article: "${title.trim()}"\n\nProduced by Aston VIP — Corporate Advisory.\nVisit https://aston.ae for more.`;
    const youtubeUrl  = await uploadToYouTube(videoBuffer, title.trim(), description);
    console.log(`[upload-video] YouTube URL: ${youtubeUrl}`);

    await updatePostVideoUrl(postId, youtubeUrl);
    console.log(`[upload-video] WP post ${postId} patched.`);

    return NextResponse.json({ youtubeUrl });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[upload-video] Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
