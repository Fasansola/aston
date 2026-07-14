/**
 * lib/social/bluesky.connector.ts
 * Bluesky connector — AT Protocol. Open and developer-friendly: authenticate
 * with a handle + app password (no app review, no business account).
 *
 * Post ids are encoded as `${uri}|${cid}` because a reply needs both the AT-URI
 * and the content hash (cid) of the post it answers.
 *
 * Docs: https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
  SocialComment,
} from "@/lib/social/types";

const CHAR_LIMIT = 300; // Bluesky counts graphemes; 300 is the hard limit.

interface StrongRef {
  uri: string;
  cid: string;
}
interface Session {
  pds: string;
  accessJwt: string;
  did: string;
  handle: string;
}

function resolve(config: Record<string, string>) {
  const pds = (config.pdsUrl || process.env.BLUESKY_PDS_URL || "https://bsky.social").replace(/\/+$/, "");
  const identifier = config.identifier || process.env.BLUESKY_IDENTIFIER || "";
  const password = config.appPassword || process.env.BLUESKY_APP_PASSWORD || "";
  return { pds, identifier, password };
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** at://did/app.bsky.feed.post/<rkey> → https://bsky.app/profile/<handle>/post/<rkey> */
function webUrl(uri: string, handle: string): string {
  const rkey = uri.split("/").pop();
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function encodeId(ref: StrongRef): string {
  return `${ref.uri}|${ref.cid}`;
}
function decodeId(id: string): StrongRef {
  const [uri, cid] = id.split("|");
  return { uri, cid };
}

export default class BlueskyConnector implements SocialConnector {
  readonly charLimit = CHAR_LIMIT;

  private async login(config: Record<string, string>): Promise<Session> {
    const { pds, identifier, password } = resolve(config);
    const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    if (!res.ok) throw new Error(`Bluesky login failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { accessJwt: string; did: string; handle: string };
    return { pds, accessJwt: data.accessJwt, did: data.did, handle: data.handle };
  }

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { identifier, password } = resolve(config);
    if (!identifier) errors.push("Bluesky handle / identifier is required");
    if (!password) errors.push("Bluesky app password is required");
    if (errors.length) return { ok: false, errors };
    try {
      await this.login(config);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    return { ok: errors.length === 0, errors };
  }

  /** Upload one image blob and return its ref, or throw. */
  private async uploadBlob(session: Session, url: string): Promise<unknown> {
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`could not fetch media ${url} (${imgRes.status})`);
    const type = imgRes.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const res = await fetch(`${session.pds}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": type },
      body: buf,
    });
    if (!res.ok) throw new Error(`blob upload failed (${res.status}): ${await res.text()}`);
    const data = (await res.json()) as { blob: unknown };
    return data.blob;
  }

  private async createRecord(session: Session, record: Record<string, unknown>): Promise<StrongRef> {
    const res = await fetch(`${session.pds}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
    });
    if (!res.ok) throw new Error(`createRecord failed (${res.status}): ${await res.text()}`);
    return (await res.json()) as StrongRef;
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    try {
      const session = await this.login(input.targetConfig);

      // Fit caption to the grapheme limit, leaving room for an appended link.
      let text = post.text.trim();
      let status: SocialPublishResult["status"] = "passed";
      let note = "";
      const linkSuffix = post.link ? `\n\n${post.link}` : "";
      if (Array.from(text + linkSuffix).length > CHAR_LIMIT) {
        const room = CHAR_LIMIT - Array.from(linkSuffix).length - 1;
        text = Array.from(text).slice(0, Math.max(0, room)).join("").trimEnd() + "…";
        status = "warning";
        note = " (caption truncated to fit)";
      }

      // Build a link facet so the appended URL is clickable.
      const facets: unknown[] = [];
      if (post.link) {
        const byteStart = utf8Len(text) + utf8Len("\n\n");
        const full = `${text}\n\n${post.link}`;
        facets.push({
          index: { byteStart, byteEnd: utf8Len(full) },
          features: [{ $type: "app.bsky.richtext.facet#link", uri: post.link }],
        });
        text = full;
      }

      // Upload images (best-effort).
      const images: Array<{ alt: string; image: unknown }> = [];
      const urls = post.mediaUrls ?? [];
      for (let i = 0; i < Math.min(urls.length, 4); i++) {
        try {
          images.push({ alt: post.altTexts?.[i] ?? "", image: await this.uploadBlob(session, urls[i]) });
        } catch (e) {
          status = "warning";
          note += ` (image ${i + 1} skipped: ${e instanceof Error ? e.message : String(e)})`;
        }
      }

      const record: Record<string, unknown> = {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
        ...(facets.length ? { facets } : {}),
        ...(images.length ? { embed: { $type: "app.bsky.embed.images", images } } : {}),
      };

      const ref = await this.createRecord(session, record);
      return {
        target,
        ok: true,
        status,
        message: `Posted to Bluesky${note}`,
        externalUrl: webUrl(ref.uri, session.handle),
        platformPostId: encodeId(ref),
        technicalDetails: ref,
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
    try {
      const session = await this.login(input.targetConfig);
      const { uri } = decodeId(input.postId);
      const res = await fetch(
        `${session.pds}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=1`,
        { headers: { Authorization: `Bearer ${session.accessJwt}` } }
      );
      if (!res.ok) return { ok: false, comments: [], message: `Bluesky returned ${res.status}` };
      const data = (await res.json()) as {
        thread: {
          replies?: Array<{
            post: {
              uri: string;
              cid: string;
              author: { handle: string };
              record: { text: string; createdAt: string };
            };
          }>;
        };
      };
      const comments: SocialComment[] = (data.thread.replies ?? []).map((r) => ({
        id: encodeId({ uri: r.post.uri, cid: r.post.cid }),
        author: `@${r.post.author.handle}`,
        text: r.post.record.text,
        createdAt: r.post.record.createdAt,
        url: webUrl(r.post.uri, r.post.author.handle),
      }));
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    try {
      const session = await this.login(input.targetConfig);
      const parent = decodeId(input.postId);

      // Correct threading: if the target is itself a reply, keep its root;
      // otherwise the target post is the root.
      let root: StrongRef = parent;
      const threadRes = await fetch(
        `${session.pds}/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(parent.uri)}&depth=0`,
        { headers: { Authorization: `Bearer ${session.accessJwt}` } }
      );
      if (threadRes.ok) {
        const t = (await threadRes.json()) as {
          thread: { post: { record: { reply?: { root: StrongRef } } } };
        };
        if (t.thread.post.record.reply?.root) root = t.thread.post.record.reply.root;
      }

      const ref = await this.createRecord(session, {
        $type: "app.bsky.feed.post",
        text: input.text,
        createdAt: new Date().toISOString(),
        reply: { root, parent },
      });

      return {
        target: input.target,
        ok: true,
        status: "passed",
        message: "Reply posted to Bluesky",
        externalUrl: webUrl(ref.uri, session.handle),
        platformPostId: encodeId(ref),
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
