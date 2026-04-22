import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

function sanitizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default class DevToConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.apiKey) {
      errors.push("apiKey is required");
      return { ok: false, errors };
    }

    try {
      const res = await fetch("https://dev.to/api/users/me", {
        headers: { "api-key": config.apiKey },
      });
      if (!res.ok) errors.push(`DEV.to API returned ${res.status}: invalid apiKey`);
    } catch (e) {
      errors.push(`Failed to reach DEV.to API: ${String(e)}`);
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const { title, markdown, tags, canonicalUrl, target, targetConfig: config } = input;

    const sanitizedTags = tags.map(sanitizeTag).filter(Boolean).slice(0, 4);
    const published = config.published === "true";
    const effectiveCanonical = config.canonicalUrl || canonicalUrl;

    const article: Record<string, unknown> = {
      title,
      body_markdown: markdown,
      tags: sanitizedTags,
      published,
    };

    if (effectiveCanonical) article.canonical_url = effectiveCanonical;
    if (config.series) article.series = config.series;

    try {
      const res = await fetch("https://dev.to/api/articles", {
        method: "POST",
        headers: {
          "api-key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ article }),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          target,
          ok: false,
          status: "failed",
          message: `DEV.to publish failed (${res.status}): ${errText}`,
        };
      }

      const data = await res.json() as { id: number; url: string };

      return {
        target,
        ok: true,
        status: "passed",
        message: "Published to DEV.to successfully",
        externalUrl: data.url,
        platformPostId: String(data.id),
        technicalDetails: data,
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
