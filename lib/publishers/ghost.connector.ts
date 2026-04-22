import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

async function signGhostJwt(id: string, secret: string): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: id })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: "/admin/" })).toString("base64url");
  const data = `${header}.${payload}`;
  const keyBytes = Buffer.from(secret, "hex");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, Buffer.from(data));
  const sigB64 = Buffer.from(sig).toString("base64url");
  return `${data}.${sigB64}`;
}

export default class GhostConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.siteUrl) errors.push("siteUrl is required");
    if (!config.adminApiKey) errors.push("adminApiKey is required");

    if (config.adminApiKey && !config.adminApiKey.includes(":")) {
      errors.push("adminApiKey must be in format id:secret");
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const {
      title,
      html,
      excerpt,
      tags,
      seoTitle,
      seoDescription,
      featuredImageUrl,
      target,
      targetConfig: config,
    } = input;

    const [id, secret] = config.adminApiKey.split(":");
    const status = config.status || "draft";
    const siteUrl = config.siteUrl.replace(/\/$/, "");

    try {
      const token = await signGhostJwt(id, secret);

      const postBody = {
        posts: [
          {
            title,
            html,
            status,
            excerpt,
            tags: tags.map((name) => ({ name })),
            og_title: seoTitle,
            og_description: seoDescription,
            feature_image: featuredImageUrl,
            custom_excerpt: excerpt,
          },
        ],
      };

      const res = await fetch(`${siteUrl}/ghost/api/admin/posts/`, {
        method: "POST",
        headers: {
          Authorization: `Ghost ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(postBody),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          target,
          ok: false,
          status: "failed",
          message: `Ghost publish failed (${res.status}): ${errText}`,
        };
      }

      const data = await res.json() as { posts: { id: string; url: string }[] };
      const post = data.posts[0];

      return {
        target,
        ok: true,
        status: "passed",
        message: "Published to Ghost successfully",
        externalUrl: post.url,
        platformPostId: post.id,
        technicalDetails: post,
      };
    } catch (e) {
      return {
        target,
        ok: false,
        status: "failed",
        message: `Unexpected error: ${String(e)}`,
      };
    }
  }
}
