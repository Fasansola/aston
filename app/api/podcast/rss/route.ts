/**
 * app/api/podcast/rss/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/podcast/rss  — PUBLIC podcast RSS feed for Spotify / Apple.
 *
 * Exempt from auth in proxy.ts so Spotify's crawler (no cookie) can read it.
 * Submit this URL once in Spotify for Creators; new curated episodes then appear
 * automatically as the feed refreshes.
 */

import { NextRequest } from "next/server";
import { getPodcastConfig, getPodcastEpisodes, buildPodcastRssXml } from "@/lib/podcast";

export const dynamic = "force-dynamic"; // always reflect the latest curated posts
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const config = getPodcastConfig();
  const episodes = await getPodcastEpisodes(config);

  // Canonical self URL for atom:link (use the real request origin).
  const origin = req.nextUrl.origin;
  const selfUrl = `${origin}/api/podcast/rss`;

  const xml = buildPodcastRssXml(episodes, config, selfUrl);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // Spotify re-checks periodically; a short cache eases load without delaying
      // new episodes much.
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
