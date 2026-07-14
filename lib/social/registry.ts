/**
 * lib/social/registry.ts
 * Social connector registry — maps a SocialTarget to its connector instance and
 * exposes available-target metadata (connection state + config schema) for the UI.
 * Mirrors lib/publishers/registry.ts.
 */

import type { SocialTarget, SocialConnector, AvailableSocialTarget } from "@/lib/social/types";
import MastodonConnector from "@/lib/social/mastodon.connector";
import BlueskyConnector from "@/lib/social/bluesky.connector";
import FacebookConnector from "@/lib/social/facebook.connector";
import InstagramConnector from "@/lib/social/instagram.connector";
import ThreadsConnector from "@/lib/social/threads.connector";

const connectors: Record<SocialTarget, SocialConnector> = {
  mastodon: new MastodonConnector(),
  bluesky: new BlueskyConnector(),
  facebook: new FacebookConnector(),
  instagram: new InstagramConnector(),
  threads: new ThreadsConnector(),
};

const TARGET_KEYS: SocialTarget[] = ["mastodon", "bluesky", "facebook", "instagram", "threads"];

export function getSocialConnector(target: SocialTarget): SocialConnector {
  return connectors[target];
}

export function isSocialTarget(v: string): v is SocialTarget {
  return (TARGET_KEYS as string[]).includes(v);
}

export function getAvailableSocialTargets(): AvailableSocialTarget[] {
  const mastodonOk = !!(process.env.MASTODON_INSTANCE_URL && process.env.MASTODON_ACCESS_TOKEN);
  const blueskyOk = !!(process.env.BLUESKY_IDENTIFIER && process.env.BLUESKY_APP_PASSWORD);
  const facebookOk = !!(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
  const instagramOk = !!(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID && (process.env.INSTAGRAM_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN));
  const threadsOk = !!(process.env.THREADS_USER_ID && process.env.THREADS_ACCESS_TOKEN);

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
    {
      key: "facebook",
      label: "Facebook",
      description: "Post to a Facebook Page — needs a reviewed Meta app + Page token",
      connected: facebookOk,
      connectionState: facebookOk ? "connected" : !process.env.FACEBOOK_PAGE_ID ? "config_incomplete" : "missing_token",
      charLimit: connectors.facebook.charLimit,
      supportsMedia: true,
      supportsComments: true,
      configFields: [
        { key: "pageId", label: "Page ID", type: "text", required: false, placeholder: "Leave blank to use FACEBOOK_PAGE_ID" },
        { key: "accessToken", label: "Page access token", type: "text", required: false, placeholder: "Leave blank to use FACEBOOK_PAGE_ACCESS_TOKEN", isSecret: true },
      ],
    },
    {
      key: "instagram",
      label: "Instagram",
      description: "Business/Creator account — needs a reviewed Meta app; image required",
      connected: instagramOk,
      connectionState: instagramOk ? "connected" : !process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ? "config_incomplete" : "missing_token",
      charLimit: connectors.instagram.charLimit,
      supportsMedia: true,
      supportsComments: true,
      configFields: [
        { key: "igUserId", label: "IG Business account ID", type: "text", required: false, placeholder: "Leave blank to use INSTAGRAM_BUSINESS_ACCOUNT_ID" },
        { key: "accessToken", label: "Access token", type: "text", required: false, placeholder: "Leave blank to use INSTAGRAM_ACCESS_TOKEN / Page token", isSecret: true },
      ],
    },
    {
      key: "threads",
      label: "Threads",
      description: "Official Threads API — needs a reviewed Meta app; text or image",
      connected: threadsOk,
      connectionState: threadsOk ? "connected" : !process.env.THREADS_USER_ID ? "config_incomplete" : "missing_token",
      charLimit: connectors.threads.charLimit,
      supportsMedia: true,
      supportsComments: true,
      configFields: [
        { key: "userId", label: "Threads user ID", type: "text", required: false, placeholder: "Leave blank to use THREADS_USER_ID" },
        { key: "accessToken", label: "Access token", type: "text", required: false, placeholder: "Leave blank to use THREADS_ACCESS_TOKEN", isSecret: true },
      ],
    },
  ];
}
