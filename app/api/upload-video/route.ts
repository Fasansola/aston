/**
 * app/api/upload-video/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/upload-video
 *
 * Accepts either:
 *   videoUrl   — Shotstack MP4 URL (fetched server-side, then uploaded)
 *   videoBase64 — legacy base64 encoded video (backward compat)
 *
 * Uploads to YouTube (public) and patches the WP post's ACF video_url.
 */

import { NextRequest, NextResponse } from "next/server";
import { uploadToYouTube, updatePostVideoUrl, postVideoComment } from "@/lib/video";
import { generateYouTubeSeoPackage, CHAPTERS_PLACEHOLDER, CONTACT_URL } from "@/lib/youtubeSeo";
import { publishWordPressPost } from "@/lib/wordpress";

export const maxDuration = 180;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const {
    postId, title, videoUrl, videoBase64, chapters,
    focusKeyword, secondaryKeywords, summary, blogUrl, language,
  } = body as {
    postId?: number;
    title?: string;
    videoUrl?: string;
    videoBase64?: string;
    chapters?: Array<{ title: string; startSecs: number }>;
    focusKeyword?: string;
    secondaryKeywords?: string[];
    summary?: string;
    blogUrl?: string;
    language?: string | null;
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

    // ── Publish the WordPress post so the article link in the YouTube
    // description points to a live page, not a draft permalink. ──────
    let liveBlogUrl = blogUrl?.trim() || "";
    if (postId) {
      try {
        const published = await publishWordPressPost(postId);
        liveBlogUrl = published.link;
        console.log(`[upload-video] Article published — ${liveBlogUrl}`);
      } catch (publishErr) {
        // Non-fatal: log and continue with whatever URL we have. A publish
        // failure should not block the YouTube upload.
        console.warn(`[upload-video] Could not publish WP post ${postId} (non-fatal):`, publishErr instanceof Error ? publishErr.message : publishErr);
      }
    }

    // ── YouTube SEO package: keyword-first title, rich description, real tags ──
    const seo = await generateYouTubeSeoPackage({
      blogTitle: title.trim(),
      focusKeyword: focusKeyword?.trim() || title.trim(),
      secondaryKeywords: secondaryKeywords?.filter((k) => typeof k === "string" && k.trim()),
      summary: summary?.trim(),
      blogUrl: liveBlogUrl || undefined,
      language: language ?? undefined,
    });

    // Build YouTube chapter markers from the REAL rendered timings. YouTube
    // shows these as clickable sections and they can rank separately in Google.
    // First chapter MUST start at 0:00 or YouTube ignores the whole list.
    const sortedChapters = [...(chapters ?? [])].sort((a, b) => a.startSecs - b.startSecs);
    if (sortedChapters.length > 0) sortedChapters[0] = { ...sortedChapters[0], startSecs: 0 };
    const chapterLines = sortedChapters.map((c) => {
      const total = Math.max(0, Math.floor(c.startSecs));
      const m = Math.floor(total / 60);
      const s = (total % 60).toString().padStart(2, "0");
      return `${m}:${s} ${c.title}`;
    });
    const chapterBlock = chapterLines.length > 0
      ? `Chapters:\n${chapterLines.join("\n")}`
      : "";

    // Inject chapters into the {{CHAPTERS}} slot. If the model omitted the
    // placeholder, append the block; if there are no chapters, strip the slot.
    let description = seo.description.includes(CHAPTERS_PLACEHOLDER)
      ? seo.description.replace(CHAPTERS_PLACEHOLDER, chapterBlock)
      : (chapterBlock ? `${seo.description}\n\n${chapterBlock}` : seo.description);
    description = description.replace(/\n{3,}/g, "\n\n").trim(); // tidy blank runs

    console.log(`[upload-video] SEO title: "${seo.title}" | ${seo.tags.length} tags | ${chapterLines.length} chapters`);

    const youtubeUrl = await uploadToYouTube(videoBuffer, seo.title, description, seo.tags);
    console.log(`[upload-video] YouTube URL: ${youtubeUrl}`);

    await updatePostVideoUrl(postId, youtubeUrl);
    console.log(`[upload-video] WP post ${postId} patched.`);

    // ── Phase 2 SEO: top-level comment ──────────────────────────────
    // Non-fatal: needs youtube.force-ssl; a failure never blocks the upload.
    //
    // NOTE: we deliberately DO NOT upload an external CC caption track. Captions
    // are burned into the video (open captions), and YouTube auto-enables a CC
    // track for viewers who've used captions before — which would stack a second
    // set of subtitles on top of the burned-in ones.
    const videoId = new URL(youtubeUrl).searchParams.get("v") ?? "";
    let commentPosted = false;

    if (videoId) {
      const kw = focusKeyword?.trim() || title.trim();
      const commentLines = [
        `Need help with ${kw}? Book a consultation: ${CONTACT_URL}`,
        ...(liveBlogUrl?.trim() ? [`Read the full guide: ${liveBlogUrl.trim()}`] : []),
      ];
      try {
        await postVideoComment(videoId, commentLines.join("\n"));
        commentPosted = true;
        console.log(`[upload-video] Comment posted on ${videoId}`);
      } catch (comErr) {
        console.warn(`[upload-video] Comment skipped (non-fatal): ${comErr instanceof Error ? comErr.message : String(comErr)}`);
      }
    }

    return NextResponse.json({ youtubeUrl, commentPosted });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[upload-video] Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
