// Note: This connector uses an API key via query param, which only works for public blogs.
// For private blogs, OAuth2 (access token) is required by the Blogger API.

import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

export default class BloggerConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.apiKey) errors.push("apiKey is required");
    if (!config.blogId) errors.push("blogId is required");

    if (errors.length > 0) return { ok: false, errors };

    try {
      const res = await fetch(
        `https://www.googleapis.com/blogger/v3/blogs/${config.blogId}?key=${config.apiKey}`
      );
      if (!res.ok) {
        errors.push(`Blogger API returned ${res.status}: check apiKey and blogId`);
      }
    } catch (e) {
      errors.push(`Failed to reach Blogger API: ${String(e)}`);
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const { title, html, tags, target, targetConfig: config } = input;

    const isDraft = config.isDraft !== "false";
    const url = `https://www.googleapis.com/blogger/v3/blogs/${config.blogId}/posts/?key=${config.apiKey}&isDraft=${isDraft}`;

    const body = {
      kind: "blogger#post",
      title,
      content: html,
      labels: tags,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          target,
          ok: false,
          status: "failed",
          message: `Blogger publish failed (${res.status}): ${errText}`,
        };
      }

      const data = await res.json() as { id: string; url: string };

      return {
        target,
        ok: true,
        status: "passed",
        message: "Published to Blogger successfully",
        externalUrl: data.url,
        platformPostId: data.id,
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
