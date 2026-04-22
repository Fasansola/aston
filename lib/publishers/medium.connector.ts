import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

export default class MediumConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.accessToken) {
      errors.push("accessToken is required");
      return { ok: false, errors };
    }

    try {
      const res = await fetch("https://api.medium.com/v1/me", {
        headers: { Authorization: `Bearer ${config.accessToken}` },
      });
      if (!res.ok) errors.push(`Medium API returned ${res.status}: invalid accessToken`);
    } catch (e) {
      errors.push(`Failed to reach Medium API: ${String(e)}`);
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const { title, html, tags, canonicalUrl, target, targetConfig: config } = input;

    try {
      const meRes = await fetch("https://api.medium.com/v1/me", {
        headers: { Authorization: `Bearer ${config.accessToken}` },
      });

      if (!meRes.ok) {
        return {
          target,
          ok: false,
          status: "failed",
          message: `Failed to fetch Medium user: ${meRes.status}`,
        };
      }

      const meData = await meRes.json() as { data: { id: string } };
      const userId = meData.data.id;
      const publishStatus = config.publishStatus || "draft";
      const effectiveCanonical = config.canonicalUrl || canonicalUrl;

      const body: Record<string, unknown> = {
        title,
        contentFormat: "html",
        content: html,
        tags: tags.slice(0, 5),
        publishStatus,
      };

      if (effectiveCanonical) body.canonicalUrl = effectiveCanonical;

      const postRes = await fetch(`https://api.medium.com/v1/users/${userId}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!postRes.ok) {
        const errText = await postRes.text();
        return {
          target,
          ok: false,
          status: "failed",
          message: `Medium publish failed (${postRes.status}): ${errText}`,
        };
      }

      const postData = await postRes.json() as { data: { id: string; url: string } };

      return {
        target,
        ok: true,
        status: "passed",
        message: "Published to Medium successfully",
        externalUrl: postData.data.url,
        platformPostId: postData.data.id,
        technicalDetails: postData.data,
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
