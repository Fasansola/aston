/**
 * lib/publishers/wordpress.connector.ts
 * WordPress connector — publishes to any self-hosted WordPress site
 * via the REST API. The primary Aston site is pre-configured from env vars;
 * additional sites can be configured via targetConfig.
 */

import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

export default class WordPressConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];
    const url  = config.siteUrl  || process.env.WP_URL;
    const user = config.username || process.env.WP_USERNAME;
    const pass = config.password || process.env.WP_APP_PASSWORD;

    if (!url)  errors.push("WordPress site URL is required");
    if (!user) errors.push("WordPress username is required");
    if (!pass) errors.push("WordPress application password is required");

    if (errors.length) return { ok: false, errors };

    try {
      const res = await fetch(`${url}/wp-json/wp/v2/users/me`, {
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
      });
      if (!res.ok) errors.push(`Could not authenticate with WordPress (${res.status})`);
    } catch {
      errors.push("Could not reach the WordPress site");
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const { targetConfig: cfg, title, html, excerpt, tags, seoTitle, seoDescription } = input;
    const siteUrl  = cfg.siteUrl  || process.env.WP_URL        || "";
    const username = cfg.username || process.env.WP_USERNAME   || "";
    const password = cfg.password || process.env.WP_APP_PASSWORD || "";
    const status   = cfg.status   || "draft";

    try {
      const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

      const body: Record<string, unknown> = {
        title,
        content: html,
        excerpt,
        status,
        tags,
      };

      if (seoTitle || seoDescription) {
        body.meta = {
          ...(seoTitle       ? { _yoast_wpseo_title:    seoTitle }       : {}),
          ...(seoDescription ? { _yoast_wpseo_metadesc: seoDescription } : {}),
        };
      }

      const res = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        return {
          target: "wordpress",
          ok: false,
          status: "failed",
          message: data.message || `WordPress rejected the post (${res.status})`,
          technicalDetails: data,
        };
      }

      return {
        target: "wordpress",
        ok: true,
        status: "passed",
        message: `Published to WordPress as ${status}`,
        externalUrl: data.link,
        editUrl: `${siteUrl}/wp-admin/post.php?post=${data.id}&action=edit`,
        platformPostId: String(data.id),
      };
    } catch (err) {
      return {
        target: "wordpress",
        ok: false,
        status: "failed",
        message: "Failed to connect to WordPress",
        technicalDetails: err instanceof Error ? err.message : err,
      };
    }
  }
}
