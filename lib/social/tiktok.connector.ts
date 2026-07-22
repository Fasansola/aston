/**
 * lib/social/tiktok.connector.ts
 * TikTok connector — Content Posting API. TikTok is video-first: mediaUrls[0]
 * must be a VIDEO URL, pulled by TikTok (PULL_FROM_URL). Requires an OAuth token
 * from a registered app.
 *
 * Gotchas surfaced to the caller:
 *  - Until the app passes TikTok's audit, privacy_level must be SELF_ONLY —
 *    public "Direct Post" needs audit + a verified pull URL domain.
 *  - TikTok has no public API for reading or posting comments, so listComments
 *    and reply return a clear "not supported" result rather than failing loudly.
 *
 * Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
} from "@/lib/social/types";

import { resolveAccessToken } from "@/lib/social/tokenRefresh";

const API = "https://open.tiktokapis.com/v2";

async function resolve(config: Record<string, string>) {
  const token = await resolveAccessToken("tiktok", config.accessToken, process.env.TIKTOK_ACCESS_TOKEN);
  // Unaudited apps must use SELF_ONLY; PUBLIC_TO_EVERYONE requires audit.
  const privacyLevel = config.privacyLevel || process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY";
  return { token, privacyLevel };
}

const NOT_SUPPORTED =
  "TikTok's API does not support reading or posting comments programmatically — manage TikTok comments in the app.";

export default class TikTokConnector implements SocialConnector {
  readonly charLimit = 2200;

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { token } = await resolve(config);
    if (!token) errors.push("TikTok access token is required");
    return { ok: errors.length === 0, errors };
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const { token, privacyLevel } = await resolve(input.targetConfig);
    const media = post.mediaUrls ?? [];
    const isVideo = !!media[0] && /\.(mp4|mov|m4v)(\?|$)/i.test(media[0]);

    if (!media.length) {
      return {
        target,
        ok: false,
        status: "failed",
        message: "TikTok requires media — a video URL, or image URLs for a photo post.",
      };
    }

    const title = (post.link ? `${post.text}\n\n${post.link}` : post.text).slice(0, this.charLimit);

    try {
      // Videos use the video init endpoint; images post as a photo carousel via
      // the content init endpoint (both PULL_FROM_URL, both async on TikTok's side).
      const res = isVideo
        ? await fetch(`${API}/post/publish/video/init/`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({
              post_info: {
                title,
                privacy_level: privacyLevel,
                disable_comment: false,
                disable_duet: false,
                disable_stitch: false,
              },
              source_info: { source: "PULL_FROM_URL", video_url: media[0] },
            }),
          })
        : await fetch(`${API}/post/publish/content/init/`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
            body: JSON.stringify({
              post_info: {
                title: title.slice(0, 90), // photo post titles are shorter
                description: title,
                privacy_level: privacyLevel,
                disable_comment: false,
              },
              source_info: {
                source: "PULL_FROM_URL",
                photo_cover_index: 0,
                photo_images: media.slice(0, 35), // TikTok's carousel cap
              },
              post_mode: "DIRECT_POST",
              media_type: "PHOTO",
            }),
          });
      const data = (await res.json()) as {
        data?: { publish_id?: string };
        error?: { code?: string; message?: string };
      };

      if (!res.ok || (data.error && data.error.code !== "ok")) {
        return {
          target,
          ok: false,
          status: "failed",
          message: `TikTok rejected the post: ${data.error?.message || res.status}`,
          technicalDetails: data,
        };
      }

      return {
        target,
        ok: true,
        status: privacyLevel === "SELF_ONLY" ? "warning" : "passed",
        message:
          privacyLevel === "SELF_ONLY"
            ? "Sent to TikTok as a private (SELF_ONLY) post — publish publicly requires app audit."
            : "Sent to TikTok — processing; it appears once TikTok finishes encoding.",
        platformPostId: data.data?.publish_id,
        technicalDetails: data.data,
      };
    } catch (e) {
      return { target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listComments(
    _input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: []; message?: string }> {
    return { ok: false, comments: [], message: NOT_SUPPORTED };
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    return { target: input.target, ok: false, status: "failed", message: NOT_SUPPORTED };
  }
}
