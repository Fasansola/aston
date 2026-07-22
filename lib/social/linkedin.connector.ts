/**
 * lib/social/linkedin.connector.ts
 * LinkedIn connector — posts to a member profile or an organisation Page via the
 * versioned Posts API, and reads/writes comments via the Community Management
 * (socialActions) API. Requires an OAuth access token with w_member_social (and,
 * for org posts, w_organization_social) from a reviewed LinkedIn app.
 *
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 */

import type {
  SocialConnector,
  SocialPublishRequest,
  SocialPublishResult,
  ListCommentsRequest,
  ReplyRequest,
  SocialComment,
} from "@/lib/social/types";

import { resolveAccessToken } from "@/lib/social/tokenRefresh";

const API = "https://api.linkedin.com/rest";

async function resolve(config: Record<string, string>) {
  const token = await resolveAccessToken("linkedin", config.accessToken, process.env.LINKEDIN_ACCESS_TOKEN);
  // e.g. "urn:li:organization:12345" (Page) or "urn:li:person:abc" (member)
  const authorUrn = config.authorUrn || process.env.LINKEDIN_AUTHOR_URN || "";
  const version = config.version || process.env.LINKEDIN_VERSION || "202411";
  return { token, authorUrn, version };
}

/** LinkedIn "Little Text" requires these characters to be backslash-escaped in commentary. */
function escapeCommentary(text: string): string {
  return text.replace(/[\\<>~|@[\]()#*_{}]/g, (c) => `\\${c}`);
}

function headers(token: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": version,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

export default class LinkedInConnector implements SocialConnector {
  readonly charLimit = 3000;

  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const { token, authorUrn } = await resolve(config);
    if (!token) errors.push("LinkedIn access token is required");
    if (!authorUrn) errors.push("LinkedIn author URN is required (urn:li:organization:… or urn:li:person:…)");
    if (!authorUrn.startsWith("urn:li:")) errors.push("authorUrn must look like urn:li:organization:123 or urn:li:person:abc");
    return { ok: errors.length === 0, errors };
  }

  /** Register + upload an image, returning its URN, or throw. */
  private async uploadImage(token: string, version: string, authorUrn: string, url: string): Promise<string> {
    const init = await fetch(`${API}/images?action=initializeUpload`, {
      method: "POST",
      headers: headers(token, version),
      body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
    });
    if (!init.ok) throw new Error(`image init failed (${init.status}): ${await init.text()}`);
    const { value } = (await init.json()) as { value: { uploadUrl: string; image: string } };

    const img = await fetch(url);
    if (!img.ok) throw new Error(`could not fetch media ${url} (${img.status})`);
    const bytes = Buffer.from(await img.arrayBuffer());

    const up = await fetch(value.uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: bytes,
    });
    if (!up.ok) throw new Error(`image upload failed (${up.status})`);
    return value.image;
  }

  /**
   * Register + upload a video, returning its URN, or throw. Three steps:
   * initializeUpload → PUT the bytes to each returned instruction (collecting the
   * ETags) → finalizeUpload. Single-part covers short reels; large multi-part
   * files would need chunk parallelism we don't do here.
   */
  private async uploadVideo(token: string, version: string, authorUrn: string, url: string): Promise<string> {
    const vid = await fetch(url);
    if (!vid.ok) throw new Error(`could not fetch media ${url} (${vid.status})`);
    const bytes = Buffer.from(await vid.arrayBuffer());

    const init = await fetch(`${API}/videos?action=initializeUpload`, {
      method: "POST",
      headers: headers(token, version),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: authorUrn,
          fileSizeBytes: bytes.length,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });
    if (!init.ok) throw new Error(`video init failed (${init.status}): ${await init.text()}`);
    const { value } = (await init.json()) as {
      value: {
        video: string;
        uploadToken?: string;
        uploadInstructions: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
      };
    };
    const instructions = value.uploadInstructions ?? [];
    if (!instructions.length) throw new Error("video init returned no upload instructions");

    const partIds: string[] = [];
    for (const inst of instructions) {
      const chunk = bytes.subarray(inst.firstByte, inst.lastByte + 1);
      const up = await fetch(inst.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: chunk,
      });
      if (!up.ok) throw new Error(`video part upload failed (${up.status})`);
      const etag = up.headers.get("etag");
      if (!etag) throw new Error("video upload returned no ETag");
      partIds.push(etag);
    }

    const fin = await fetch(`${API}/videos?action=finalizeUpload`, {
      method: "POST",
      headers: headers(token, version),
      body: JSON.stringify({
        finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: partIds },
      }),
    });
    if (!fin.ok) throw new Error(`video finalize failed (${fin.status}): ${await fin.text()}`);
    return value.video;
  }

  async publish(input: SocialPublishRequest): Promise<SocialPublishResult> {
    const { post, target } = input;
    const { token, authorUrn, version } = await resolve(input.targetConfig);
    const commentary = escapeCommentary(post.link ? `${post.text}\n\n${post.link}` : post.text);
    const media = post.mediaUrls?.[0];
    const isVideo = !!media && /\.(mp4|mov|m4v)(\?|$)/i.test(media);

    const images = (post.mediaUrls ?? []).filter((u) => !/\.(mp4|mov|m4v)(\?|$)/i.test(u));

    let status: SocialPublishResult["status"] = "passed";
    let note = "";
    let content: Record<string, unknown> | undefined;
    if (media) {
      if (isVideo) {
        // A reel is pointless without its video, so a video failure is fatal
        // (unlike an image, which degrades to a text post below).
        try {
          const urn = await this.uploadVideo(token, version, authorUrn, media);
          content = { media: { id: urn, title: post.text.slice(0, 60) } };
        } catch (e) {
          return { target, ok: false, status: "failed", message: `LinkedIn video upload failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      } else if (images.length > 1) {
        // Carousel-style multi-image post — upload each, reference them together.
        try {
          const urns: string[] = [];
          for (const url of images.slice(0, 20)) {
            urns.push(await this.uploadImage(token, version, authorUrn, url));
          }
          content = { multiImage: { images: urns.map((id) => ({ id })) } };
        } catch (e) {
          status = "warning";
          note = ` (images skipped: ${e instanceof Error ? e.message : String(e)})`;
        }
      } else {
        try {
          const urn = await this.uploadImage(token, version, authorUrn, media);
          content = { media: { id: urn, title: post.text.slice(0, 60) } };
        } catch (e) {
          status = "warning";
          note = ` (image skipped: ${e instanceof Error ? e.message : String(e)})`;
        }
      }
    }

    const body: Record<string, unknown> = {
      author: authorUrn,
      commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      ...(content ? { content } : {}),
    };

    try {
      const res = await fetch(`${API}/posts`, {
        method: "POST",
        headers: headers(token, version),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { target, ok: false, status: "failed", message: `LinkedIn rejected the post (${res.status}): ${await res.text()}` };
      }
      // The created post URN comes back in the x-restli-id header.
      const postUrn = res.headers.get("x-restli-id") || "";
      return {
        target,
        ok: true,
        status,
        message: `Posted to LinkedIn${note}`,
        externalUrl: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : undefined,
        platformPostId: postUrn,
      };
    } catch (e) {
      return { target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async listComments(
    input: ListCommentsRequest
  ): Promise<{ ok: boolean; comments: SocialComment[]; message?: string }> {
    const { token, version } = await resolve(input.targetConfig);
    try {
      const res = await fetch(`${API}/socialActions/${encodeURIComponent(input.postId)}/comments`, {
        headers: headers(token, version),
      });
      if (!res.ok) return { ok: false, comments: [], message: `LinkedIn returned ${res.status}` };
      const data = (await res.json()) as {
        elements?: Array<{ id?: string; actor?: string; message?: { text?: string }; created?: { time?: number } }>;
      };
      const comments: SocialComment[] = (data.elements ?? []).map((c) => ({
        id: c.id ?? "",
        author: c.actor ?? "LinkedIn member",
        text: c.message?.text ?? "",
        createdAt: c.created?.time ? new Date(c.created.time).toISOString() : undefined,
      }));
      return { ok: true, comments };
    } catch (e) {
      return { ok: false, comments: [], message: e instanceof Error ? e.message : String(e) };
    }
  }

  async reply(input: ReplyRequest): Promise<SocialPublishResult> {
    const { token, authorUrn, version } = await resolve(input.targetConfig);
    try {
      const res = await fetch(`${API}/socialActions/${encodeURIComponent(input.postId)}/comments`, {
        method: "POST",
        headers: headers(token, version),
        body: JSON.stringify({ actor: authorUrn, message: { text: input.text } }),
      });
      if (!res.ok) {
        return { target: input.target, ok: false, status: "failed", message: `LinkedIn rejected the reply (${res.status}): ${await res.text()}` };
      }
      const id = res.headers.get("x-restli-id") || undefined;
      return { target: input.target, ok: true, status: "passed", message: "Reply posted to LinkedIn", platformPostId: id };
    } catch (e) {
      return { target: input.target, ok: false, status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }
}
