/**
 * lib/social/registry.ts
 * Social connector registry — maps a SocialTarget to its connector instance and
 * exposes available-target metadata (connection state + config schema) for the UI.
 * Mirrors lib/publishers/registry.ts.
 */

import type { SocialTarget, SocialConnector, AvailableSocialTarget } from "@/lib/social/types";
import FacebookConnector from "@/lib/social/facebook.connector";
import InstagramConnector from "@/lib/social/instagram.connector";
import LinkedInConnector from "@/lib/social/linkedin.connector";
import TikTokConnector from "@/lib/social/tiktok.connector";
import YouTubeConnector from "@/lib/social/youtube.connector";

const connectors: Record<SocialTarget, SocialConnector> = {
  facebook: new FacebookConnector(),
  instagram: new InstagramConnector(),
  linkedin: new LinkedInConnector(),
  tiktok: new TikTokConnector(),
  youtube: new YouTubeConnector(),
};

const TARGET_KEYS: SocialTarget[] = ["facebook", "instagram", "linkedin", "tiktok", "youtube"];

export function getSocialConnector(target: SocialTarget): SocialConnector {
  return connectors[target];
}

export function isSocialTarget(v: string): v is SocialTarget {
  return (TARGET_KEYS as string[]).includes(v);
}

export function getAvailableSocialTargets(): AvailableSocialTarget[] {
  const facebookOk = !!(process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
  const instagramOk = !!(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID && (process.env.INSTAGRAM_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN));
  const linkedinOk = !!(process.env.LINKEDIN_ACCESS_TOKEN && process.env.LINKEDIN_AUTHOR_URN);
  const tiktokOk = !!process.env.TIKTOK_ACCESS_TOKEN;
  const youtubeOk = !!(
    process.env.YOUTUBE_CLIENT_ID &&
    process.env.YOUTUBE_CLIENT_SECRET &&
    process.env.YOUTUBE_REFRESH_TOKEN
  );

  return [
    {
      key: "facebook",
      label: "Facebook",
      description: "Post to a Facebook Page — needs a reviewed Meta app + Page token",
      connected: facebookOk,
      connectionState: facebookOk ? "connected" : !process.env.FACEBOOK_PAGE_ID ? "config_incomplete" : "missing_token",
      charLimit: connectors.facebook.charLimit,
      supportsMedia: true,
      requiresMedia: false,
      supportsComments: true,
      configFields: [
        { key: "pageId", label: "Page ID", type: "text", required: false, placeholder: "Leave blank to use FACEBOOK_PAGE_ID" },
        { key: "accessToken", label: "Page access token", type: "text", required: false, placeholder: "Leave blank to use FACEBOOK_PAGE_ACCESS_TOKEN", isSecret: true },
      ],
    },
    {
      key: "instagram",
      label: "Instagram",
      description: "Business/Creator account — needs a reviewed Meta app; posts images or reels (video)",
      connected: instagramOk,
      connectionState: instagramOk ? "connected" : !process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ? "config_incomplete" : "missing_token",
      charLimit: connectors.instagram.charLimit,
      supportsMedia: true,
      requiresMedia: true,
      supportsComments: true,
      configFields: [
        { key: "igUserId", label: "IG Business account ID", type: "text", required: false, placeholder: "Leave blank to use INSTAGRAM_BUSINESS_ACCOUNT_ID" },
        { key: "accessToken", label: "Access token", type: "text", required: false, placeholder: "Leave blank to use INSTAGRAM_ACCESS_TOKEN / Page token", isSecret: true },
      ],
    },
    {
      key: "linkedin",
      label: "LinkedIn",
      description: "Member or organisation Page — needs a reviewed LinkedIn app (high B2B value)",
      connected: linkedinOk,
      connectionState: linkedinOk ? "connected" : !process.env.LINKEDIN_ACCESS_TOKEN ? "missing_token" : "config_incomplete",
      charLimit: connectors.linkedin.charLimit,
      supportsMedia: true,
      requiresMedia: false,
      supportsComments: true,
      configFields: [
        { key: "authorUrn", label: "Author URN", type: "text", required: false, placeholder: "urn:li:organization:123 or urn:li:person:abc (else LINKEDIN_AUTHOR_URN)" },
        { key: "accessToken", label: "Access token", type: "text", required: false, placeholder: "Leave blank to use LINKEDIN_ACCESS_TOKEN", isSecret: true },
      ],
    },
    {
      key: "tiktok",
      label: "TikTok",
      description: "Video-first — needs app audit for public posts; no comments API",
      connected: tiktokOk,
      connectionState: tiktokOk ? "connected" : "missing_token",
      charLimit: connectors.tiktok.charLimit,
      supportsMedia: true,
      requiresMedia: true,
      supportsComments: false,
      configFields: [
        { key: "accessToken", label: "Access token", type: "text", required: false, placeholder: "Leave blank to use TIKTOK_ACCESS_TOKEN", isSecret: true },
        {
          key: "privacyLevel", label: "Privacy", type: "select", required: false, default: "SELF_ONLY",
          options: [
            { value: "SELF_ONLY", label: "Private (no audit needed)" },
            { value: "PUBLIC_TO_EVERYONE", label: "Public (requires app audit)" },
          ],
        },
      ],
    },
    {
      key: "youtube",
      label: "YouTube",
      description: "Uploads a vertical reel as a Short — reuses the blog pipeline's YouTube connection",
      connected: youtubeOk,
      connectionState: youtubeOk ? "connected" : "missing_token",
      charLimit: connectors.youtube.charLimit,
      supportsMedia: true,
      requiresMedia: true,
      supportsComments: true,
      // Auth is the shared YouTube OAuth refresh token in env — nothing to enter here.
      configFields: [],
    },
  ];
}
