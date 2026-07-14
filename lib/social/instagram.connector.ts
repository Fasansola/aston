/**
 * lib/social/instagram.connector.ts
 * Instagram connector — Content Publishing API. Requires an Instagram Business
 * or Creator account linked to a Facebook Page, and a reviewed Meta app with
 * instagram_content_publish.
 *
 * Instagram is media-first: a post MUST have an image. Publishing is two steps —
 * create a media container, then publish it.
 *
 * Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
  SocialComment,
} from "@/lib/social/types";
import { graphCall, FB_GRAPH_BASE } from "@/lib/social/metaGraph";
import { resolveAccessToken } from "@/lib/social/tokenRefresh";

async function resolve(config: Record<string, string>) {
  const igUserId = config.igUserId || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";
  // IG uses the linked Page/User access token; fall back to the Facebook one.
  const token = await resolveAccessToken(
    "instagram",
    config.accessToken,
    process.env.INSTAGRAM_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN
  );
  return { igUserId, token };
}

export default class InstagramConnector implements SocialConnector {
  readonly charLimit = 2200;

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { igUserId, token } = await resolve(config);
    if (!igUserId) errors.push("Instagram Business account ID is required");
    if (!token) errors.push("Instagram/Facebook access token is required");
    if (errors.length) return { ok: false, errors };
    try {
      await graphCall(FB_GRAPH_BASE, igUserId, { fields: "username", access_token: token });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    return { ok: errors.length === 0, errors };
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const { igUserId, token } = await resolve(input.targetConfig);
    const image = post.mediaUrls?.[0];

    if (!image) {
      return {
        target,
        ok: false,
        status: "failed",
        message: "Instagram requires an image — add at least one media URL.",
      };
    }
    // The link can't be clickable in an IG caption, but include it for reference.
    const caption = post.link ? `${post.text}\n\n${post.link}` : post.text;

    try {
      // Step 1: create the media container.
      const container = await graphCall<{ id: string }>(
        FB_GRAPH_BASE,
        `${igUserId}/media`,
        { image_url: image, caption, access_token: token },
        "POST"
      );
      // Step 2: publish it.
      const published = await graphCall<{ id: string }>(
        FB_GRAPH_BASE,
        `${igUserId}/media_publish`,
        { creation_id: container.id, access_token: token },
        "POST"
      );

      let permalink: string | undefined;
      try {
        const meta = await graphCall<{ permalink?: string }>(FB_GRAPH_BASE, published.id, {
          fields: "permalink",
          access_token: token,
        });
        permalink = meta.permalink;
      } catch {
        /* permalink is best-effort */
      }

      return {
        target,
        ok: true,
        status: "passed",
        message: "Posted to Instagram",
        externalUrl: permalink,
        platformPostId: published.id,
      };
    } catch (e) {
      return { target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listComments(
    input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: SocialComment[]; message?: string }> {
    const { token } = await resolve(input.targetConfig);
    try {
      const data = await graphCall<{
        data: Array<{ id: string; text: string; username?: string; timestamp: string }>;
      }>(FB_GRAPH_BASE, `${input.postId}/comments`, {
        fields: "id,text,username,timestamp",
        access_token: token,
      });
      const comments: SocialComment[] = (data.data ?? []).map((c) => ({
        id: c.id,
        author: c.username ? `@${c.username}` : "Instagram user",
        text: c.text,
        createdAt: c.timestamp,
      }));
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    const { token } = await resolve(input.targetConfig);
    try {
      // Reply to a comment id via its /replies edge.
      const data = await graphCall<{ id: string }>(
        FB_GRAPH_BASE,
        `${input.postId}/replies`,
        { message: input.text, access_token: token },
        "POST"
      );
      return {
        target: input.target,
        ok: true,
        status: "passed",
        message: "Reply posted to Instagram",
        platformPostId: data.id,
      };
    } catch (e) {
      return { target: input.target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
