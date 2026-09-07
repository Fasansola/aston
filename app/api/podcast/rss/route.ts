/**
 * app/api/podcast/rss/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/podcast/rss  — PUBLIC podcast RSS feed for Spotify / Apple.
 *
 * Exempt from auth in proxy.ts so Spotify's crawler (no cookie) can read it.
 * Submit this URL once in Spotify for Creators; new curated episodes then appear
 * automatically as the feed refreshes.
 *
 * Resilience (see lib/podcast.ts getPodcastEpisodes): one bounded WordPress
 * fetch, falling back to the last good copy in Redis, so a SiteGround
 * anti-bot challenge never produces a 504 or an empty channel. On top of that
 * the CDN keeps a copy for 15 minutes and serves it stale for a day while
 * refreshing, so most crawler hits never reach WordPress at all.
 */

import { NextRequest } from "next/server";
import { getPodcastConfig, getPodcastEpisodes, buildPodcastRssXml } from "@/lib/podcast";

export const dynamic = "force-dynamic"; // always reflect the latest curated posts
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const config = getPodcastConfig();
  const result = await getPodcastEpisodes(config);

  // Canonical self URL for atom:link (use the real request origin).
  const origin = req.nextUrl.origin;
  const selfUrl = `${origin}/api/podcast/rss`;

  const xml = buildPodcastRssXml(result.episodes, config, selfUrl);

  const headers: Record<string, string> = {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=86400, stale-if-error=604800",
    "X-Feed-Source": result.source,
  };
  if (result.cachedAt) headers["X-Feed-Cached-At"] = result.cachedAt;
  if (result.error) console.warn(`[podcast/rss] served ${result.episodes.length} episode(s) from ${result.source}: ${result.error}`);

  return new Response(xml, { headers });
}
