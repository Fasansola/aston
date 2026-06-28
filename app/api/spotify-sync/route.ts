/**
 * app/api/spotify-sync/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/spotify-sync
 *
 * Matches Spotify episodes to WordPress podcast CPT posts and embeds the
 * Spotify player automatically. Designed to be called periodically (cron or
 * manual) — Spotify typically takes 1–4 hours to ingest a new RSS episode,
 * so running this every 2–4 hours catches new episodes.
 *
 * Logic:
 *   1. Fetch latest Spotify episodes for the show (by SPOTIFY_SHOW_ID)
 *   2. Fetch WordPress podcast CPT posts that don't yet have a spotify_embed_url
 *   3. Match by normalised title (case-insensitive, stripped of punctuation)
 *   4. For each match, patch the WP post's ACF spotify_embed_url with the iframe
 *
 * Env:
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_SHOW_ID — Spotify API
 *   WP_URL, WP_USERNAME, WP_APP_PASSWORD — WordPress REST API
 *   PODCAST_CPT_REST_BASE — custom post type REST base (default "podcast")
 *
 * Also callable via POST with the same behavior (for manual trigger from the UI).
 */

import { NextResponse } from "next/server";
import { getShowEpisodes, spotifyEmbedHtml, spotifyEpisodeUrl } from "@/lib/spotify";

export const maxDuration = 60;

const WP_URL  = process.env.WP_URL!;
const WP_AUTH = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");
const CPT_BASE = process.env.PODCAST_CPT_REST_BASE || "podcast";

function normalise(title: string): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

interface WpPodcastPost {
  id: number;
  title: { rendered: string };
  acf?: Record<string, unknown>;
}

async function handler() {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_SHOW_ID) {
    return NextResponse.json({ message: "Spotify not configured (SPOTIFY_CLIENT_ID / SPOTIFY_SHOW_ID missing)" }, { status: 200 });
  }

  // 1. Fetch latest Spotify episodes
  const spotifyEpisodes = await getShowEpisodes(50);
  if (spotifyEpisodes.length === 0) {
    return NextResponse.json({ message: "No Spotify episodes found", synced: 0 });
  }

  // 2. Fetch WP podcast posts that don't yet have a Spotify embed
  let wpPosts: WpPodcastPost[] = [];
  try {
    const res = await fetch(
      `${WP_URL}/wp-json/wp/v2/${CPT_BASE}?per_page=50&orderby=date&order=desc`,
      { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(20_000) }
    );
    if (res.ok) {
      wpPosts = (await res.json()) as WpPodcastPost[];
    }
  } catch (err) {
    console.warn(`[spotify-sync] WP fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Filter to posts missing a Spotify embed
  const unsynced = wpPosts.filter((p) => {
    const embed = p.acf?.spotify_embed_url;
    return !embed || (typeof embed === "string" && embed.trim().length === 0);
  });

  if (unsynced.length === 0) {
    return NextResponse.json({ message: "All podcast posts already have Spotify embeds", synced: 0 });
  }

  // 3. Build a lookup map: normalised Spotify title → episode
  const spotifyMap = new Map<string, typeof spotifyEpisodes[0]>();
  for (const ep of spotifyEpisodes) {
    spotifyMap.set(normalise(ep.name), ep);
  }

  // 4. Match and patch
  const results: Array<{ postId: number; title: string; spotifyUrl: string }> = [];
  for (const post of unsynced) {
    const wpTitle = normalise(post.title.rendered.replace(/<[^>]+>/g, ""));
    const match = spotifyMap.get(wpTitle);
    if (!match) continue;

    const embedHtml = spotifyEmbedHtml(match.id);
    const embedUrl  = spotifyEpisodeUrl(match.id);
    try {
      await fetch(`${WP_URL}/wp-json/wp/v2/${CPT_BASE}/${post.id}`, {
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
      console.log(`[spotify-sync] Synced post ${post.id} "${post.title.rendered}" → ${embedUrl}`);
      results.push({ postId: post.id, title: post.title.rendered, spotifyUrl: embedUrl });
    } catch (err) {
      console.warn(`[spotify-sync] Failed to patch post ${post.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    message: `Synced ${results.length} episode(s)`,
    synced: results.length,
    total_spotify: spotifyEpisodes.length,
    total_unsynced_wp: unsynced.length,
    results,
  });
}

export async function GET()  { return handler(); }
export async function POST() { return handler(); }
