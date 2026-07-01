/**
 * app/api/spotify-sync/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET or POST /api/spotify-sync
 *
 * Embeds the Spotify podcast player into the blog posts that had podcasts
 * generated from them. Runs every 4 hours via Vercel cron.
 *
 * Flow (no fuzzy title matching — uses the explicit link stored at
 * generation time, same pattern as YouTube video embedding):
 *
 *   1. Fetch latest Spotify episodes for the show (SPOTIFY_SHOW_ID)
 *   2. Fetch podcast CPT entries that have a source_post_id (the blog post
 *      the podcast was generated from — stored at generation time)
 *   3. Match CPT entries to Spotify episodes by normalised title. The CPT
 *      title IS the podcast episode title (both come from episodeTitle), so
 *      this is a near-exact match — not the fragile blog-post-to-Spotify
 *      title matching the old approach used.
 *   4. For each match, patch the SOURCE BLOG POST (via source_post_id)
 *      with the Spotify embed iframe.
 *
 * Env:
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_SHOW_ID
 *   WP_URL, WP_USERNAME, WP_APP_PASSWORD
 *   PODCAST_CPT_REST_BASE (default "podcast")
 */

import { NextResponse } from "next/server";
import { getShowEpisodes, spotifyEpisodeUrl } from "@/lib/spotify";

export const maxDuration = 60;

const WP_URL   = process.env.WP_URL!;
const WP_AUTH  = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");
const CPT_BASE = process.env.PODCAST_CPT_REST_BASE || "podcast";

function normalise(title: string): string {
  return (title ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&[a-z]+;/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface WpCptPost {
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
    });
  }
  console.log(`[spotify-sync] ${spotifyEpisodes.length} Spotify episodes fetched`);

  // 2. Fetch podcast CPT entries (these have the explicit source_post_id link).
  let cptPosts: WpCptPost[] = [];
  try {
    const res = await fetch(
      `${WP_URL}/wp-json/wp/v2/${CPT_BASE}?per_page=100&orderby=date&order=desc`,
      { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(20_000) }
    );
    if (res.ok) {
      cptPosts = (await res.json()) as WpCptPost[];
    }
  } catch (err) {
    console.warn(`[spotify-sync] WP CPT fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Filter to CPT entries that have a source_post_id (the linked blog post)
  const linked = cptPosts.filter((p) => {
    const spid = p.acf?.source_post_id;
    return typeof spid === "number" && spid > 0;
  });
  console.log(`[spotify-sync] ${cptPosts.length} podcast CPT entries, ${linked.length} with source_post_id`);

  if (linked.length === 0) {
    return NextResponse.json({
      message: "No podcast CPT entries with source_post_id found. Generate a new podcast to create the link.",
      synced: 0,
      total_spotify: spotifyEpisodes.length,
      total_cpt: cptPosts.length,
    });
  }

  // 3. Build Spotify title → episode map (the CPT title IS the episode title)
  const spotifyMap = new Map<string, typeof spotifyEpisodes[0]>();
  for (const ep of spotifyEpisodes) {
    spotifyMap.set(normalise(ep.name), ep);
  }

  // 4. For each linked CPT entry, check if the source blog post already has
  //    a Spotify embed. If not, match the CPT title to Spotify and patch.
  const results: Array<{ blogPostId: number; cptId: number; title: string; spotifyUrl: string }> = [];
  const skipped: Array<{ cptId: number; title: string; reason: string }> = [];

  for (const cpt of linked) {
    const sourcePostId = cpt.acf!.source_post_id as number;
    const cptTitle = normalise(cpt.title.rendered.replace(/<[^>]+>/g, ""));

    // Check if blog post already has a Spotify embed
    try {
      const postRes = await fetch(
        `${WP_URL}/wp-json/wp/v2/posts/${sourcePostId}?_fields=id,acf`,
        { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(10_000) }
      );
      if (!postRes.ok) {
        skipped.push({ cptId: cpt.id, title: cptTitle, reason: `blog post ${sourcePostId} not found (${postRes.status})` });
        continue;
      }
      const postData = await postRes.json() as { acf?: Record<string, unknown> };
      const existing = postData.acf?.spotify_embed_url;
      if (existing && typeof existing === "string" && existing.trim().length > 0) {
        continue; // already synced
      }
    } catch {
      skipped.push({ cptId: cpt.id, title: cptTitle, reason: "failed to check blog post" });
      continue;
    }

    // Match CPT title to Spotify episode
    const spotifyMatch = spotifyMap.get(cptTitle);
    if (!spotifyMatch) {
      skipped.push({ cptId: cpt.id, title: cptTitle, reason: "no Spotify episode with matching title yet" });
      continue;
    }

    // Patch the source blog post with the Spotify URL
    const embedUrl = spotifyEpisodeUrl(spotifyMatch.id);
    try {
      await fetch(`${WP_URL}/wp-json/wp/v2/posts/${sourcePostId}`, {
        method: "POST",
        headers: { Authorization: `Basic ${WP_AUTH}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          acf: {
            spotify_embed_url: embedUrl,
                      },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      console.log(`[spotify-sync] Embedded Spotify in blog post ${sourcePostId} (from CPT ${cpt.id}) → ${embedUrl}`);
      results.push({ blogPostId: sourcePostId, cptId: cpt.id, title: cpt.title.rendered, spotifyUrl: embedUrl });
    } catch (err) {
      console.warn(`[spotify-sync] Failed to patch blog post ${sourcePostId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    message: results.length > 0
      ? `Embedded Spotify player in ${results.length} blog post(s)`
      : "No new matches — episodes may not be on Spotify yet",
    synced: results.length,
    total_spotify: spotifyEpisodes.length,
    total_linked_cpt: linked.length,
    results,
    skipped: skipped.length > 0 ? skipped : undefined,
    spotify_titles: spotifyEpisodes.map(e => normalise(e.name)),
    cpt_titles: linked.map(c => normalise(c.title.rendered.replace(/<[^>]+>/g, ""))),
  });
}

export async function GET()  { return handler(); }
export async function POST() { return handler(); }
