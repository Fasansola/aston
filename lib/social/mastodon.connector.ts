/**
 * lib/social/mastodon.connector.ts
 * Mastodon connector — the simplest social target: a plain REST API, per-instance,
 * authenticated with a single access token. No app review, no business account.
 *
 * Docs: https://docs.joinmastodon.org/methods/statuses/
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
  SocialComment,
} from "@/lib/social/types";

const DEFAULT_CHAR_LIMIT = 500;

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolve(config: Record<string, string>) {
  const instance = (config.instanceUrl || process.env.MASTODON_INSTANCE_URL || "").replace(/\/+$/, "");
  const token = config.accessToken || process.env.MASTODON_ACCESS_TOKEN || "";
  const visibility = config.visibility || "public";
  return { instance, token, visibility };
}

export default class MastodonConnector implements SocialConnector {
  readonly charLimit = DEFAULT_CHAR_LIMIT;

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { instance, token } = resolve(config);
    if (!instance) errors.push("Mastodon instance URL is required");
    if (!token) errors.push("Mastodon access token is required");
    if (errors.length) return { ok: false, errors };

    try {
      const res = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) errors.push(`Mastodon rejected the access token (${res.status})`);
    } catch {
      errors.push(`Could not reach the Mastodon instance at ${instance}`);
    }
    return { ok: errors.length === 0, errors };
  }

  /** Upload one image and return its media id, or throw. */
  private async uploadMedia(
    instance: string,
    token: string,
    url: string,
    alt: string
  ): Promise<string> {
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`could not fetch media ${url} (${imgRes.status})`);
    const buf = await imgRes.arrayBuffer();
    const type = imgRes.headers.get("content-type") || "image/jpeg";

    const form = new FormData();
    form.append("file", new Blob([buf], { type }), "image");
    if (alt) form.append("description", alt.slice(0, 1500));

    const res = await fetch(`${instance}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`media upload failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const { instance, token, visibility } = resolve(input.targetConfig);

    // Assemble caption + link, then fit to the character limit.
    let body = post.text.trim();
    if (post.link) body = `${body}\n\n${post.link}`;
    let status: SocialPublishResult["status"] = "passed";
    let note = "";
    if (body.length > this.charLimit) {
      const keep = this.charLimit - 1 - (post.link ? post.link.length + 2 : 0);
      const head = post.text.trim().slice(0, Math.max(0, keep)).trimEnd() + "…";
      body = post.link ? `${head}\n\n${post.link}` : head;
      status = "warning";
      note = " (caption truncated to fit)";
    }

    try {
      // Upload media first (Mastodon needs media ids before creating the status).
      const mediaIds: string[] = [];
      const urls = post.mediaUrls ?? [];
      for (let i = 0; i < Math.min(urls.length, 4); i++) {
        try {
          mediaIds.push(await this.uploadMedia(instance, token, urls[i], post.altTexts?.[i] ?? ""));
        } catch (e) {
          // Non-fatal: post the text even if one image fails.
          status = "warning";
          note += ` (image ${i + 1} skipped: ${e instanceof Error ? e.message : String(e)})`;
        }
      }

      const res = await fetch(`${instance}/api/v1/statuses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          status: body,
          visibility,
          ...(mediaIds.length ? { media_ids: mediaIds } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return {
          target,
          ok: false,
          status: "failed",
          message: data.error || `Mastodon rejected the post (${res.status})`,
          technicalDetails: data,
        };
      }

      return {
        target,
        ok: true,
        status,
        message: `Posted to Mastodon${note}`,
        externalUrl: data.url,
        platformPostId: String(data.id),
        technicalDetails: { id: data.id },
      };
    } catch (e) {
      return {
        target,
        ok: false,
        status: "failed",
        message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  async listComments(
    input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: SocialComment[]; message?: string }> {
    const { instance, token } = resolve(input.targetConfig);
    try {
      const res = await fetch(`${instance}/api/v1/statuses/${input.postId}/context`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, comments: [], message: `Mastodon returned ${res.status}` };
      const data = (await res.json()) as {
        descendants: Array<{
          id: string;
          content: string;
          created_at: string;
          url: string;
          account: { acct: string };
        }>;
      };
      const comments: SocialComment[] = data.descendants.map((d) => ({
        id: d.id,
        author: `@${d.account.acct}`,
        text: stripHtml(d.content),
        createdAt: d.created_at,
        url: d.url,
      }));
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    const { instance, token, visibility } = resolve(input.targetConfig);
    try {
      const res = await fetch(`${instance}/api/v1/statuses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          status: input.text,
          in_reply_to_id: input.postId,
          visibility,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          target: input.target,
          ok: false,
          status: "failed",
          message: data.error || `Mastodon rejected the reply (${res.status})`,
          technicalDetails: data,
        };
      }
      return {
        target: input.target,
        ok: true,
        status: "passed",
        message: "Reply posted to Mastodon",
        externalUrl: data.url,
        platformPostId: String(data.id),
      };
    } catch (e) {
      return {
        target: input.target,
        ok: false,
        status: "failed",
        message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
