/**
 * lib/social/tokenStore.ts
 * Durable OAuth token store for the gated social platforms (Meta family +
 * LinkedIn + TikTok). Records live in Upstash Redis (same adapter as
 * lib/storage.ts, with a data/*.json fallback for local dev), keyed per
 * platform. This removes the every-~60-days manual env-token rotation: a token
 * is seeded once, then kept alive by the refresher (lib/social/tokenRefresh.ts).
 *
 * Backward compatible: connectors fall back to their env token when no record
 * is stored, so nothing breaks before a platform is seeded.
 */

import { kget, kset } from "@/lib/storage";
import type { SocialTarget } from "@/lib/social/types";

export interface OAuthTokenRecord {
  /** The current usable access token. */
  accessToken: string;
  /** Refresh token, where the platform issues one (LinkedIn, TikTok). */
  refreshToken?: string;
  /** Absolute expiry, epoch ms. Absent = non-expiring or unknown (never auto-refreshed). */
  expiresAt?: number;
  /** For platforms whose refresh token itself expires (LinkedIn, TikTok), epoch ms. */
  refreshTokenExpiresAt?: number;
  scope?: string;
  /** When this record was last written, epoch ms. */
  updatedAt: number;
  /** Last refresh outcome, for surfacing in the dashboard. */
  lastRefreshedAt?: number;
  lastRefreshError?: string;
}

/** Platforms that use the OAuth token store (mastodon/bluesky do not). */
export const STORED_PLATFORMS: SocialTarget[] = [
  "facebook",
  "instagram",
  "threads",
  "linkedin",
  "tiktok",
];

const key = (platform: SocialTarget) => `aston:social:token:${platform}`;

export async function getToken(platform: SocialTarget): Promise<OAuthTokenRecord | null> {
  return kget<OAuthTokenRecord | null>(key(platform), null);
}

export async function saveToken(platform: SocialTarget, record: OAuthTokenRecord): Promise<void> {
  return kset(key(platform), { ...record, updatedAt: Date.now() });
}

export async function deleteToken(platform: SocialTarget): Promise<void> {
  return kset<OAuthTokenRecord | null>(key(platform), null);
}

/**
 * Seed or overwrite a platform token, e.g. from a token obtained via the
 * platform's OAuth flow / Graph API Explorer. `expiresInSeconds` is converted to
 * an absolute expiry so refresh timing survives restarts.
 */
export async function setTokenFromGrant(
  platform: SocialTarget,
  grant: {
    accessToken: string;
    refreshToken?: string;
    expiresInSeconds?: number;
    refreshTokenExpiresInSeconds?: number;
    scope?: string;
  }
): Promise<OAuthTokenRecord> {
  const now = Date.now();
  const record: OAuthTokenRecord = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: grant.expiresInSeconds ? now + grant.expiresInSeconds * 1000 : undefined,
    refreshTokenExpiresAt: grant.refreshTokenExpiresInSeconds
      ? now + grant.refreshTokenExpiresInSeconds * 1000
      : undefined,
    scope: grant.scope,
    updatedAt: now,
  };
  await saveToken(platform, record);
  return record;
}

export interface TokenStatus {
  platform: SocialTarget;
  /** Where the connector's token comes from right now. */
  source: "store" | "env" | "none";
  hasRefreshToken: boolean;
  expiresAt?: number;
  expiresInDays?: number;
  refreshTokenExpiresAt?: number;
  lastRefreshedAt?: number;
  lastRefreshError?: string;
}

/** True when the given env token(s) are configured for a platform. */
function envTokenPresent(platform: SocialTarget): boolean {
  switch (platform) {
    case "facebook":
      return !!process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    case "instagram":
      return !!(process.env.INSTAGRAM_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
    case "threads":
      return !!process.env.THREADS_ACCESS_TOKEN;
    case "linkedin":
      return !!process.env.LINKEDIN_ACCESS_TOKEN;
    case "tiktok":
      return !!process.env.TIKTOK_ACCESS_TOKEN;
    default:
      return false;
  }
}

export async function getTokenStatuses(): Promise<TokenStatus[]> {
  const now = Date.now();
  const out: TokenStatus[] = [];
  for (const platform of STORED_PLATFORMS) {
    const rec = await getToken(platform);
    const source: TokenStatus["source"] = rec?.accessToken
      ? "store"
      : envTokenPresent(platform)
        ? "env"
        : "none";
    out.push({
      platform,
      source,
      hasRefreshToken: !!rec?.refreshToken,
      expiresAt: rec?.expiresAt,
      expiresInDays:
        rec?.expiresAt !== undefined
          ? Math.round(((rec.expiresAt - now) / 86_400_000) * 10) / 10
          : undefined,
      refreshTokenExpiresAt: rec?.refreshTokenExpiresAt,
      lastRefreshedAt: rec?.lastRefreshedAt,
      lastRefreshError: rec?.lastRefreshError,
    });
  }
  return out;
}
