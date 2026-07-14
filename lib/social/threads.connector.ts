/**
 * lib/social/threads.connector.ts
 * Threads connector — the official Threads API (graph.threads.net). Two-step
 * publish like Instagram, but text-only posts are allowed. Requires a Threads
 * access token from a reviewed Meta app.
 *
 * Docs: https://developers.facebook.com/docs/threads/posts
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
  SocialComment,
} from "@/lib/social/types";
import { graphCall, THREADS_GRAPH_BASE } from "@/lib/social/metaGraph";

function resolve(config: Record<string, string>) {
  const userId = config.userId || process.env.THREADS_USER_ID || "";
  const token = config.accessToken || process.env.THREADS_ACCESS_TOKEN || "";
  return { userId, token };
}

export default class ThreadsConnector implements SocialConnector {
  readonly charLimit = 500;

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { userId, token } = resolve(config);
    if (!userId) errors.push("Threads user ID is required");
    if (!token) errors.push("Threads access token is required");
    if (errors.length) return { ok: false, errors };
    try {
      await graphCall(THREADS_GRAPH_BASE, userId, { fields: "username", access_token: token });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    return { ok: errors.length === 0, errors };
  }

  /** Create a media container, then publish it. Shared by publish() and reply(). */
  private async createAndPublish(
    userId: string,
    token: string,
    params: Record<string, string>
  ): Promise<string> {
    const container = await graphCall<{ id: string }>(
      THREADS_GRAPH_BASE,
      `${userId}/threads`,
      { ...params, access_token: token },
      "POST"
    );
    const published = await graphCall<{ id: string }>(
      THREADS_GRAPH_BASE,
      `${userId}/threads_publish`,
      { creation_id: container.id, access_token: token },
      "POST"
    );
    return published.id;
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const { userId, token } = resolve(input.targetConfig);
    const text = post.link ? `${post.text}\n\n${post.link}` : post.text;
    const image = post.mediaUrls?.[0];

    try {
      const threadId = await this.createAndPublish(userId, token, {
        media_type: image ? "IMAGE" : "TEXT",
        text,
        ...(image ? { image_url: image } : {}),
      });

      let permalink: string | undefined;
      try {
        const meta = await graphCall<{ permalink?: string }>(THREADS_GRAPH_BASE, threadId, {
          fields: "permalink",
          access_token: token,
        });
        permalink = meta.permalink;
      } catch {
        /* best-effort */
      }

      return {
        target,
        ok: true,
        status: "passed",
        message: "Posted to Threads",
        externalUrl: permalink,
        platformPostId: threadId,
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
        data: Array<{ id: string; text: string; username?: string; timestamp: string; permalink?: string }>;
      }>(THREADS_GRAPH_BASE, `${input.postId}/replies`, {
        fields: "id,text,username,timestamp,permalink",
        access_token: token,
      });
      const comments: SocialComment[] = (data.data ?? []).map((c) => ({
        id: c.id,
        author: c.username ? `@${c.username}` : "Threads user",
        text: c.text,
        createdAt: c.timestamp,
        url: c.permalink,
      }));
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    const { userId, token } = resolve(input.targetConfig);
    try {
      const threadId = await this.createAndPublish(userId, token, {
        media_type: "TEXT",
        text: input.text,
        reply_to_id: input.postId,
      });
      return {
        target: input.target,
        ok: true,
        status: "passed",
        message: "Reply posted to Threads",
        platformPostId: threadId,
      };
    } catch (e) {
      return { target: input.target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
