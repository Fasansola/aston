/**
 * lib/publishers/registry.ts
 * Connector registry — maps PublishTarget to connector instances and
 * provides available-target metadata for the frontend.
 */

import type { PublishTarget, PublisherConnector, AvailableTarget } from "@/lib/publishers/types";
import WordPressConnector from "@/lib/publishers/wordpress.connector";
import MediumConnector   from "@/lib/publishers/medium.connector";
import DevToConnector    from "@/lib/publishers/devto.connector";
import HashnodeConnector from "@/lib/publishers/hashnode.connector";
import BloggerConnector  from "@/lib/publishers/blogger.connector";
import GhostConnector    from "@/lib/publishers/ghost.connector";
import EmailConnector    from "@/lib/publishers/email.connector";

const connectors: Record<PublishTarget, PublisherConnector> = {
  wordpress: new WordPressConnector(),
  medium:    new MediumConnector(),
  devto:     new DevToConnector(),
  hashnode:  new HashnodeConnector(),
  blogger:   new BloggerConnector(),
  ghost:     new GhostConnector(),
  email:     new EmailConnector(),
};

export function getConnector(target: PublishTarget): PublisherConnector {
  return connectors[target];
}

// ── Connection state detection ─────────────────────────────────

function connectionState(
  configured: boolean
): AvailableTarget["connectionState"] {
  return configured ? "connected" : "missing_token";
}

export function getAvailableTargets(): AvailableTarget[] {
  const wpOk      = !!(process.env.WP_URL && process.env.WP_USERNAME && process.env.WP_APP_PASSWORD);
  const mediumOk  = !!process.env.MEDIUM_ACCESS_TOKEN;
  const devtoOk   = !!process.env.DEV_TO_API_KEY;
  const hashnodeOk = !!(process.env.HASHNODE_TOKEN && process.env.HASHNODE_PUBLICATION_ID);
  const bloggerOk = !!(process.env.BLOGGER_API_KEY && process.env.BLOGGER_BLOG_ID);
  const ghostOk   = !!(process.env.GHOST_URL && process.env.GHOST_ADMIN_API_KEY);
  const emailOk   = !!(process.env.RESEND_API_KEY && process.env.EMAIL_TO);

  return [
    {
      key: "wordpress",
      label: "WordPress",
      description: "Your primary Aston.ae site",
      enabled: true,
      requiresAuth: true,
      connected: wpOk,
      connectionState: wpOk ? "connected" : "config_incomplete",
      configFields: [
        { key: "siteUrl",  label: "Site URL",    type: "text", required: false, placeholder: "Leave blank to use default Aston site" },
        { key: "username", label: "Username",    type: "text", required: false, placeholder: "Leave blank to use default credentials" },
        { key: "password", label: "App password",type: "text", required: false, placeholder: "Leave blank to use default credentials", isSecret: true },
        {
          key: "status", label: "Post status", type: "select", required: false, default: "draft",
          options: [{ value: "draft", label: "Draft" }, { value: "pending", label: "Pending review" }, { value: "publish", label: "Publish now" }],
        },
      ],
    },
    {
      key: "medium",
      label: "Medium",
      description: "For broad professional reach",
      enabled: false,
      requiresAuth: true,
      connected: mediumOk,
      connectionState: connectionState(mediumOk),
      configFields: [
        { key: "accessToken",    label: "Access token",  type: "text",   required: true,  placeholder: "Your Medium self-issued access token", isSecret: true },
        { key: "publishStatus",  label: "Publish status", type: "select", required: false, default: "draft",
          options: [{ value: "draft", label: "Draft" }, { value: "unlisted", label: "Unlisted" }, { value: "public", label: "Public" }] },
        { key: "canonicalUrl",   label: "Canonical URL", type: "text",   required: false, placeholder: "https://aston.ae/blog/…" },
      ],
    },
    {
      key: "devto",
      label: "DEV",
      description: "For developer and technical audiences",
      enabled: false,
      requiresAuth: true,
      connected: devtoOk,
      connectionState: connectionState(devtoOk),
      configFields: [
        { key: "apiKey",       label: "API key",      type: "text",   required: true,  placeholder: "Your DEV.to API key", isSecret: true },
        { key: "published",    label: "Publish",      type: "select", required: false, default: "false",
          options: [{ value: "false", label: "Save as draft" }, { value: "true", label: "Publish now" }] },
        { key: "canonicalUrl", label: "Canonical URL",type: "text",   required: false, placeholder: "https://aston.ae/blog/…" },
        { key: "series",       label: "Series",       type: "text",   required: false, placeholder: "Optional — series name" },
      ],
    },
    {
      key: "hashnode",
      label: "Hashnode",
      description: "For technical blogging and custom publications",
      enabled: false,
      requiresAuth: true,
      connected: hashnodeOk,
      connectionState: hashnodeOk ? "connected" : (!process.env.HASHNODE_TOKEN ? "missing_token" : "config_incomplete"),
      configFields: [
        { key: "token",          label: "API token",        type: "text", required: true,  placeholder: "Your Hashnode API token", isSecret: true },
        { key: "publicationId",  label: "Publication ID",   type: "text", required: true,  placeholder: "Your Hashnode publication ID" },
        { key: "canonicalUrl",   label: "Canonical URL",    type: "text", required: false, placeholder: "https://aston.ae/blog/…" },
      ],
    },
    {
      key: "blogger",
      label: "Blogger",
      description: "For simple Google-based blog publishing",
      enabled: false,
      requiresAuth: true,
      connected: bloggerOk,
      connectionState: bloggerOk ? "connected" : (!process.env.BLOGGER_API_KEY ? "missing_token" : "config_incomplete"),
      configFields: [
        { key: "apiKey",  label: "Google API key", type: "text",   required: true,  placeholder: "Your Google API key", isSecret: true },
        { key: "blogId",  label: "Blog ID",         type: "text",   required: true,  placeholder: "Your Blogger blog ID" },
        { key: "isDraft", label: "Save as draft",   type: "select", required: false, default: "true",
          options: [{ value: "true", label: "Draft" }, { value: "false", label: "Publish now" }] },
      ],
    },
    {
      key: "ghost",
      label: "Ghost",
      description: "For owned publication publishing",
      enabled: false,
      requiresAuth: true,
      connected: ghostOk,
      connectionState: ghostOk ? "connected" : (!process.env.GHOST_URL ? "missing_token" : "config_incomplete"),
      configFields: [
        { key: "siteUrl",      label: "Ghost site URL",    type: "text",   required: true,  placeholder: "https://myblog.ghost.io" },
        { key: "adminApiKey",  label: "Admin API key",     type: "text",   required: true,  placeholder: "id:secret format", isSecret: true },
        { key: "status",       label: "Post status",       type: "select", required: false, default: "draft",
          options: [{ value: "draft", label: "Draft" }, { value: "published", label: "Publish now" }] },
      ],
    },
    {
      key: "email",
      label: "Send by email",
      description: "For internal review or distribution",
      enabled: false,
      requiresAuth: true,
      connected: emailOk,
      connectionState: emailOk ? "connected" : (!process.env.RESEND_API_KEY ? "missing_token" : "config_incomplete"),
      configFields: [
        { key: "apiKey",  label: "Resend API key",    type: "text",  required: true,  placeholder: "Your Resend API key", isSecret: true },
        { key: "to",      label: "Recipient email",   type: "email", required: true,  placeholder: "recipient@example.com" },
        { key: "from",    label: "Sender email",      type: "email", required: false, placeholder: "noreply@aston.ae" },
        { key: "subject", label: "Subject (optional)", type: "text", required: false, placeholder: "Defaults to article title" },
      ],
    },
  ];
}
