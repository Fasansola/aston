/**
 * app/api/spotify-sync/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET or POST /api/spotify-sync
 *
 * Embeds the Spotify podcast player directly into blog posts that had a
 * podcast generated from them. Runs every 4 hours via Vercel cron.
 *
 * Logic:
 *   1. Fetch latest Spotify episodes for the show (SPOTIFY_SHOW_ID)
 *   2. Fetch recent WordPress blog posts (wp/v2/posts)
 *   3. Match by normalised title — the podcast episode title is derived from
 *      the blog post title, so they correspond after normalisation
 *   4. For each matched post that doesn't already have a spotify_embed_url,
 *      patch the post's ACF with the Spotify embed iframe
 *
 * Env:
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_SHOW_ID
 *   WP_URL, WP_USERNAME, WP_APP_PASSWORD
 */

import { NextResponse } from "next/server";
import { getShowEpisodes, spotifyEmbedHtml, spotifyEpisodeUrl } from "@/lib/spotify";

export const maxDuration = 60;

const WP_URL  = process.env.WP_URL!;
const WP_AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");

function normalise(title: string): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

interface WpPost {
  id: number;
  title: { rendered: string };
  acf?: Record<string, unknown>;
}

async function handler() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_SHOW_ID) {
    return NextResponse.json({ message: "Spotify not configured (SPOTIFY_CLIENT_ID / SPOTIFY_SHOW_ID missing)" }, { status: 200 });
  }

  // 1. Fetch latest Spotify episodes
  const { episodes: spotifyEpisodes, error: spotifyError } = await getShowEpisodes(50);
  if (spotifyEpisodes.length === 0) {
    return NextResponse.json({
      message: "No Spotify episodes found",
      synced: 0,
      error: spotifyError ?? null,
      showId: process.env.SPOTIFY_SHOW_ID ?? "(not set)",
      clientIdSet: !!process.env.SPOTIFY_CLIENT_ID,
      clientSecretSet: !!process.env.SPOTIFY_CLIENT_SECRET,
    });
  }
  console.log(`[spotify-sync] ${spotifyEpisodes.length} Spotify episodes fetched`);

  // 2. Fetch recent WordPress blog posts (regular posts, not the podcast CPT).
  //    We check the last 100 posts — any older and they'll already have been synced
  //    on a previous run or predate the podcast feature.
  let wpPosts: WpPost[] = [];
  try {
    const res = await fetch(
      `${WP_URL}/wp-json/wp/v2/posts?per_page=100&orderby=date&order=desc`,
      { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(20_000) }
    );
    if (res.ok) {
      wpPosts = (await res.json()) as WpPost[];
    }
  } catch (err) {
    console.warn(`[spotify-sync] WP fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Filter to posts that don't already have a Spotify embed
  const unsynced = wpPosts.filter((p) => {
    const embed = p.acf?.spotify_embed_url;
    return !embed || (typeof embed === "string" && embed.trim().length === 0);
  });
  console.log(`[spotify-sync] ${wpPosts.length} blog posts fetched, ${unsynced.length} without Spotify embed`);

  if (unsynced.length === 0) {
    return NextResponse.json({ message: "All recent posts already have Spotify embeds (or no posts found)", synced: 0 });
  }

  // 3. Build a lookup map: normalised Spotify title → episode
  const spotifyMap = new Map<string, typeof spotifyEpisodes[0]>();
  for (const ep of spotifyEpisodes) {
    spotifyMap.set(normalise(ep.name), ep);
  }

  // 4. Match blog post titles to Spotify episode titles and patch
  const results: Array<{ postId: number; title: string; spotifyUrl: string }> = [];
  const spotifyTitles = [...spotifyMap.keys()];
  const unmatchedWp: string[] = [];
  for (const post of unsynced) {
    const wpTitle = normalise(post.title.rendered.replace(/<[^>]+>/g, ""));
    const match = spotifyMap.get(wpTitle);
    if (!match) { unmatchedWp.push(wpTitle.slice(0, 60)); continue; }

    const embedHtml = spotifyEmbedHtml(match.id);
    const embedUrl  = spotifyEpisodeUrl(match.id);
    try {
      await fetch(`${WP_URL}/wp-json/wp/v2/posts/${post.id}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${WP_AUTH}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          acf: {
            spotify_embed_url: embedUrl,
            spotify_embed_html: embedHtml,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      console.log(`[spotify-sync] Embedded Spotify in blog post ${post.id} "${post.title.rendered}" → ${embedUrl}`);
      results.push({ postId: post.id, title: post.title.rendered, spotifyUrl: embedUrl });
    } catch (err) {
      console.warn(`[spotify-sync] Failed to patch post ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    message: results.length > 0
      ? `Embedded Spotify player in ${results.length} blog post(s)`
      : "No new matches found (episodes may not be on Spotify yet, or titles don't match)",
    synced: results.length,
    total_spotify: spotifyEpisodes.length,
    total_unsynced_posts: unsynced.length,
    results,
    // Debug: show what titles are being compared so mismatches are obvious
    debug: {
      spotify_titles: spotifyTitles,
      sample_wp_titles: unmatchedWp.slice(0, 10),
    },
  });
}

export async function GET()  { return handler(); }
export async function POST() { return handler(); }
