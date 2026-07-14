/**
 * lib/social/tokenRefresh.ts
 * Keeps stored OAuth tokens alive and hands connectors a usable access token.
 *
 *  resolveAccessToken(platform, configToken, envToken)
 *    The single entry point connectors use. Priority:
 *      1. an explicit per-request token (targetConfig.accessToken) — always wins
 *      2. the stored token, refreshed inline if it is about to expire
 *      3. the env token — backward-compatible fallback for un-seeded platforms
 *
 *  refreshAll() — called by the daily cron to proactively refresh anything
 *    within REFRESH_AHEAD of expiry, so inline refreshes almost never fire.
 *
 * Refresh flows differ per platform:
 *  - linkedin / tiktok : standard OAuth2 refresh_token grant (needs client creds)
 *  - threads           : long-lived token self-refresh (th_refresh_token)
 *  - facebook/instagram: fb_exchange_token extension of the long-lived token
 *
 * Concurrency note: the daily cron is the primary refresher (single run). Inline
 * refresh only fires within INLINE_AHEAD of expiry, so two requests racing to
 * rotate a single-use refresh token is very unlikely at this scale.
 */

import type { SocialTarget } from "@/lib/social/types";
import { getToken, saveToken, STORED_PLATFORMS, type OAuthTokenRecord } from "@/lib/social/tokenStore";

const DAY = 86_400_000;
/** Cron refreshes tokens expiring within this window. */
const REFRESH_AHEAD = 7 * DAY;
/** Inline (request-path) refresh only fires this close to expiry. */
const INLINE_AHEAD = 1 * DAY;

const META_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

type RefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  refreshTokenExpiresInSeconds?: number;
  scope?: string;
};

/** Per-platform refresher. Returns fresh token fields, or throws with a clear message. */
type Refresher = (rec: OAuthTokenRecord) => Promise<RefreshResult>;

const refreshers: Partial<Record<SocialTarget, Refresher>> = {
  linkedin: async (rec) => {
    const id = process.env.LINKEDIN_CLIENT_ID;
    const secret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!id || !secret) throw new Error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET not set");
    if (!rec.refreshToken) throw new Error("no LinkedIn refresh token stored");
    const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rec.refreshToken,
        client_id: id,
        client_secret: secret,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`LinkedIn refresh ${res.status}: ${JSON.stringify(data)}`);
    return {
      accessToken: String(data.access_token),
      refreshToken: (data.refresh_token as string) || rec.refreshToken,
      expiresInSeconds: Number(data.expires_in) || undefined,
      refreshTokenExpiresInSeconds: Number(data.refresh_token_expires_in) || undefined,
    };
  },

  tiktok: async (rec) => {
    const key = process.env.TIKTOK_CLIENT_KEY;
    const secret = process.env.TIKTOK_CLIENT_SECRET;
    if (!key || !secret) throw new Error("TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not set");
    if (!rec.refreshToken) throw new Error("no TikTok refresh token stored");
    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: key,
        client_secret: secret,
        grant_type: "refresh_token",
        refresh_token: rec.refreshToken,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.error) throw new Error(`TikTok refresh ${res.status}: ${JSON.stringify(data)}`);
    return {
      accessToken: String(data.access_token),
      refreshToken: (data.refresh_token as string) || rec.refreshToken,
      expiresInSeconds: Number(data.expires_in) || undefined,
      refreshTokenExpiresInSeconds: Number(data.refresh_expires_in) || undefined,
    };
  },

  // Long-lived Threads token self-refresh — no client secret, extends by ~60 days.
  threads: async (rec) => {
    const url = new URL("https://graph.threads.net/refresh_access_token");
    url.searchParams.set("grant_type", "th_refresh_token");
    url.searchParams.set("access_token", rec.accessToken);
    const res = await fetch(url);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Threads refresh ${res.status}: ${JSON.stringify(data)}`);
    return { accessToken: String(data.access_token), expiresInSeconds: Number(data.expires_in) || undefined };
  },

  // Meta long-lived token extension. A Page token derived from a long-lived user
  // token may come back non-expiring (no expires_in) — that's fine.
  facebook: metaExchange,
  instagram: metaExchange,
};

async function metaExchange(rec: OAuthTokenRecord): Promise<RefreshResult> {
  const id = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  if (!id || !secret) throw new Error("META_APP_ID / META_APP_SECRET not set");
  const url = new URL(`https://graph.facebook.com/${META_VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", id);
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("fb_exchange_token", rec.accessToken);
  const res = await fetch(url);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Meta token exchange ${res.status}: ${JSON.stringify(data)}`);
  return { accessToken: String(data.access_token), expiresInSeconds: Number(data.expires_in) || undefined };
}

/** Apply a RefreshResult back onto a stored record, computing absolute expiries. */
function applyRefresh(rec: OAuthTokenRecord, r: RefreshResult): OAuthTokenRecord {
  const now = Date.now();
  return {
    ...rec,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken ?? rec.refreshToken,
    expiresAt: r.expiresInSeconds ? now + r.expiresInSeconds * 1000 : rec.expiresAt,
    refreshTokenExpiresAt: r.refreshTokenExpiresInSeconds
      ? now + r.refreshTokenExpiresInSeconds * 1000
      : rec.refreshTokenExpiresAt,
    scope: r.scope ?? rec.scope,
    updatedAt: now,
    lastRefreshedAt: now,
    lastRefreshError: undefined,
  };
}

/**
 * Refresh the stored token if it is within `ahead` ms of expiry. Returns the
 * (possibly refreshed) record. On refresh failure it records the error and
 * returns the existing record — a stale-but-usable token beats a hard failure.
 */
async function refreshIfNeeded(
  platform: SocialTarget,
  rec: OAuthTokenRecord,
  ahead: number
): Promise<OAuthTokenRecord> {
  if (rec.expiresAt === undefined) return rec; // non-expiring / unknown — leave it
  if (rec.expiresAt - Date.now() > ahead) return rec; // still fresh enough

  const refresher = refreshers[platform];
  if (!refresher) return rec;

  try {
    const next = applyRefresh(rec, await refresher(rec));
    await saveToken(platform, next);
    return next;
  } catch (e) {
    const errored = { ...rec, lastRefreshError: e instanceof Error ? e.message : String(e) };
    await saveToken(platform, errored);
    return errored;
  }
}

/**
 * The token a connector should use right now. An explicit per-request token
 * always wins; otherwise the stored token (refreshed inline if nearly expired);
 * otherwise the env token for backward compatibility.
 */
export async function resolveAccessToken(
  platform: SocialTarget,
  configToken?: string,
  envToken?: string
): Promise<string> {
  if (configToken) return configToken;
  const rec = await getToken(platform);
  if (rec?.accessToken) {
    const fresh = await refreshIfNeeded(platform, rec, INLINE_AHEAD);
    return fresh.accessToken;
  }
  return envToken || "";
}

/** Cron entry point: proactively refresh every stored token nearing expiry. */
export async function refreshAll(): Promise<
  Array<{ platform: SocialTarget; refreshed: boolean; error?: string }>
> {
  const out: Array<{ platform: SocialTarget; refreshed: boolean; error?: string }> = [];
  for (const platform of STORED_PLATFORMS) {
    const rec = await getToken(platform);
    if (!rec?.accessToken) continue;
    const before = rec.accessToken;
    const after = await refreshIfNeeded(platform, rec, REFRESH_AHEAD);
    out.push({
      platform,
      refreshed: after.accessToken !== before,
      error: after.lastRefreshError,
    });
  }
  return out;
}
