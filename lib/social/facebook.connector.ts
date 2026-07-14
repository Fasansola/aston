/**
 * lib/social/facebook.connector.ts
 * Facebook Page connector — posts to a Page (never a personal profile) via the
 * Graph API. Requires a Page access token with pages_manage_posts, from a
 * reviewed Meta app.
 *
 * Docs: https://developers.facebook.com/docs/pages-api/posts
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

function resolve(config: Record<string, string>) {
  const pageId = config.pageId || process.env.FACEBOOK_PAGE_ID || "";
  const token = config.accessToken || process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";
  return { pageId, token };
}

export default class FacebookConnector implements SocialConnector {
  readonly charLimit = 63206;

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { pageId, token } = resolve(config);
    if (!pageId) errors.push("Facebook Page ID is required");
    if (!token) errors.push("Facebook Page access token is required");
    if (errors.length) return { ok: false, errors };
    try {
      await graphCall(FB_GRAPH_BASE, pageId, { fields: "name", access_token: token });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    return { ok: errors.length === 0, errors };
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const { pageId, token } = resolve(input.targetConfig);
    const message = post.link ? `${post.text}\n\n${post.link}` : post.text;
    const image = post.mediaUrls?.[0];

    try {
      let postId: string;
      if (image) {
        // Photo post — caption goes in `message`.
        const data = await graphCall<{ id: string; post_id?: string }>(
          FB_GRAPH_BASE,
          `${pageId}/photos`,
          { url: image, message, access_token: token },
          "POST"
        );
        postId = data.post_id || data.id;
      } else {
        const data = await graphCall<{ id: string }>(
          FB_GRAPH_BASE,
          `${pageId}/feed`,
          { message, ...(post.link ? { link: post.link } : {}), access_token: token },
          "POST"
        );
        postId = data.id;
      }
      return {
        target,
        ok: true,
        status: "passed",
        message: "Posted to Facebook Page",
        externalUrl: `https://www.facebook.com/${postId}`,
        platformPostId: postId,
      };
    } catch (e) {
      return { target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listComments(
    input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: SocialComment[]; message?: string }> {
    const { token } = resolve(input.targetConfig);
    try {
      const data = await graphCall<{
        data: Array<{ id: string; message: string; created_time: string; from?: { name: string } }>;
      }>(FB_GRAPH_BASE, `${input.postId}/comments`, {
        fields: "id,message,from,created_time",
        access_token: token,
      });
      const comments: SocialComment[] = (data.data ?? []).map((c) => ({
        id: c.id,
        author: c.from?.name ?? "Facebook user",
        text: c.message,
        createdAt: c.created_time,
      }));
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    const { token } = resolve(input.targetConfig);
    try {
      // Commenting on a post OR a comment id both use the /{object-id}/comments edge.
      const data = await graphCall<{ id: string }>(
        FB_GRAPH_BASE,
        `${input.postId}/comments`,
        { message: input.text, access_token: token },
        "POST"
      );
      return {
        target: input.target,
        ok: true,
        status: "passed",
        message: "Reply posted to Facebook",
        platformPostId: data.id,
      };
    } catch (e) {
      return { target: input.target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
