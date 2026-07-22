/**
 * lib/social/youtube.connector.ts
 * YouTube connector — reuses the existing YouTube upload + OAuth already set up
 * for the blog video pipeline (lib/video.ts). A vertical reel under 60 seconds
 * is auto-detected by YouTube as a Short.
 *
 * Auth is the YouTube OAuth refresh token in env (YOUTUBE_CLIENT_ID /
 * _SECRET / _REFRESH_TOKEN), which googleapis refreshes itself — so YouTube is
 * NOT part of the social OAuth token store.
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
  SocialComment,
} from "@/lib/social/types";
import { uploadToYouTube, listVideoComments, replyToVideoComment } from "@/lib/video";

function videoIdFromUrl(watchUrl: string): string {
  return new URL(watchUrl).searchParams.get("v") ?? "";
}

export default class YouTubeConnector implements SocialConnector {
  // YouTube description limit.
  readonly charLimit = 5000;

  async validateConfig(): Promise<{ ok: boolean; errors: string[] }> {
    const missing = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"].filter(
      (k) => !process.env[k]
    );
    return missing.length
      ? { ok: false, errors: [`YouTube not connected. Missing: ${missing.join(", ")}`] }
      : { ok: true, errors: [] };
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const videoUrl = post.mediaUrls?.[0];
    if (!videoUrl) {
      return {
        target,
        ok: false,
        status: "failed",
        message: "YouTube requires a video — pass the reel URL as the first media URL.",
      };
    }

    // Title from the first non-empty line; #Shorts nudges YouTube to file a
    // vertical <60s clip as a Short. Description carries the full caption + link.
    const firstLine = post.text.split("\n").find((l) => l.trim())?.trim() || "Aston VIP";
    const title = `${firstLine.slice(0, 90)} #Shorts`;
    const description = post.link ? `${post.text}\n\n${post.link}` : post.text;

    try {
      const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`could not fetch video ${videoUrl} (${res.status})`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const watchUrl = await uploadToYouTube(buffer, title, description);
      return {
        target,
        ok: true,
        status: "passed",
        message: "Uploaded to YouTube",
        externalUrl: watchUrl,
        platformPostId: videoIdFromUrl(watchUrl),
      };
    } catch (e) {
      return { target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listComments(
    input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: SocialComment[]; message?: string }> {
    try {
      const comments = await listVideoComments(input.postId);
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    try {
      const id = await replyToVideoComment(input.postId, input.text);
      return { target: input.target, ok: true, status: "passed", message: "Reply posted to YouTube", platformPostId: id };
    } catch (e) {
      return { target: input.target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
