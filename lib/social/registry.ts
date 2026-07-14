/**
 * lib/social/registry.ts
 * Social connector registry — maps a SocialTarget to its connector instance and
 * exposes available-target metadata (connection state + config schema) for the UI.
 * Mirrors lib/publishers/registry.ts.
 */

import type { SocialTarget, SocialConnector, AvailableSocialTarget } from "@/lib/social/types";
import MastodonConnector from "@/lib/social/mastodon.connector";
import BlueskyConnector from "@/lib/social/bluesky.connector";

const connectors: Record<SocialTarget, SocialConnector> = {
  mastodon: new MastodonConnector(),
  bluesky: new BlueskyConnector(),
};

export function getSocialConnector(target: SocialTarget): SocialConnector {
  return connectors[target];
}

export function isSocialTarget(v: string): v is SocialTarget {
  return v === "mastodon" || v === "bluesky";
}

export function getAvailableSocialTargets(): AvailableSocialTarget[] {
  const mastodonOk = !!(process.env.MASTODON_INSTANCE_URL && process.env.MASTODON_ACCESS_TOKEN);
  const blueskyOk = !!(process.env.BLUESKY_IDENTIFIER && process.env.BLUESKY_APP_PASSWORD);

  return [
    {
      key: "mastodon",
      label: "Mastodon",
      description: "Open federated network — no app review, posts + replies via API",
      connected: mastodonOk,
      connectionState: mastodonOk
        ? "connected"
        : !process.env.MASTODON_INSTANCE_URL
          ? "config_incomplete"
          : "missing_token",
      charLimit: connectors.mastodon.charLimit,
      supportsMedia: true,
      supportsComments: true,
      configFields: [
        { key: "instanceUrl", label: "Instance URL", type: "text", required: false, placeholder: "Leave blank to use MASTODON_INSTANCE_URL" },
        { key: "accessToken", label: "Access token", type: "text", required: false, placeholder: "Leave blank to use MASTODON_ACCESS_TOKEN", isSecret: true },
        {
          key: "visibility", label: "Visibility", type: "select", required: false, default: "public",
          options: [
            { value: "public", label: "Public" },
            { value: "unlisted", label: "Unlisted" },
            { value: "private", label: "Followers only" },
          ],
        },
      ],
    },
    {
      key: "bluesky",
      label: "Bluesky",
      description: "AT Protocol — open API, posts + threaded replies, no app review",
      connected: blueskyOk,
      connectionState: blueskyOk
        ? "connected"
        : !process.env.BLUESKY_IDENTIFIER
          ? "missing_token"
          : "config_incomplete",
      charLimit: connectors.bluesky.charLimit,
      supportsMedia: true,
      supportsComments: true,
      configFields: [
        { key: "identifier", label: "Handle", type: "text", required: false, placeholder: "Leave blank to use BLUESKY_IDENTIFIER (e.g. aston.bsky.social)" },
        { key: "appPassword", label: "App password", type: "text", required: false, placeholder: "Leave blank to use BLUESKY_APP_PASSWORD", isSecret: true },
        { key: "pdsUrl", label: "PDS URL", type: "text", required: false, placeholder: "Defaults to https://bsky.social" },
      ],
    },
  ];
}
