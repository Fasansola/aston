/**
 * lib/spotify.ts
 * ─────────────────────────────────────────────────────────────
 * Spotify Web API client (client-credentials flow, no user login).
 *
 * Used to look up podcast episodes by show ID so we can match them to
 * WordPress podcast CPT posts and embed the Spotify player automatically.
 *
 * Env:
 *   SPOTIFY_CLIENT_ID      — from https://developer.spotify.com/dashboard
 *   SPOTIFY_CLIENT_SECRET
 *   SPOTIFY_SHOW_ID        — the Spotify show/podcast ID (from the show URL)
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE  = "https://api.spotify.com/v1";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Spotify token request failed (${res.status}): ${err.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

export interface SpotifyEpisode {
  id: string;           // Spotify episode ID
  name: string;         // episode title
  external_urls: { spotify: string };
  release_date: string;
  uri: string;          // spotify:episode:...
}

/**
 * Fetch the latest episodes for the configured show. Returns up to `limit`
 * episodes, newest first. Non-fatal — returns [] on error so the sync never
 * crashes the caller.
 */
export async function getShowEpisodes(limit = 50): Promise<{ episodes: SpotifyEpisode[]; error?: string }> {
  const showId = process.env.SPOTIFY_SHOW_ID;
  if (!showId) {
    return { episodes: [], error: "SPOTIFY_SHOW_ID not set" };
  }
  try {
    const token = await getAccessToken();
    const url = `${API_BASE}/shows/${showId}/episodes?limit=${limit}&offset=0&market=US`;
    console.log(`[spotify] Fetching episodes: ${url}`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      const msg = `Spotify API returned ${res.status}: ${err.slice(0, 300)}`;
      console.warn(`[spotify] ${msg}`);
      return { episodes: [], error: msg };
    }
    const data = await res.json() as { items?: SpotifyEpisode[] };
    console.log(`[spotify] Got ${data.items?.length ?? 0} episodes`);
    return { episodes: data.items ?? [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spotify] getShowEpisodes failed: ${msg}`);
    return { episodes: [], error: msg };
  }
}

/**
 * Build the oEmbed/iframe URL for a Spotify episode that WordPress will
 * auto-embed when pasted into the block editor, or that can be stored as
 * an HTML iframe in an ACF field.
 */
export function spotifyEmbedHtml(episodeId: string): string {
  return `<iframe style="border-radius:12px" src="https://open.spotify.com/embed/episode/${episodeId}?utm_source=generator&theme=0" width="100%" height="352" frameBorder="0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
}

export function spotifyEpisodeUrl(episodeId: string): string {
  return `https://open.spotify.com/episode/${episodeId}`;
}
