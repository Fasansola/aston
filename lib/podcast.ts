/**
 * lib/podcast.ts
 * ─────────────────────────────────────────────────────────────
 * Builds a Spotify-compatible podcast RSS feed from curated WordPress posts.
 *
 * Curation: a post becomes an episode when it is assigned the configured
 * WordPress category (default slug "podcast") AND has a narration MP3 in its
 * ACF `audio_url` field.
 *
 * Spotify (and Apple) ingest the feed URL and create/refresh episodes whenever
 * a new <item> appears. The feed is served publicly (see proxy.ts exemption).
 */

import { fetchWithSgRetry } from "./wordpress";
import { kget, kset } from "./storage";
import { WP_API_BASE } from "./wpApi";

const WP_URL = WP_API_BASE; // REST base: the site, or the fixed-IP relay when WP_API_URL is set
const WP_AUTH = Buffer.from(
  `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
).toString("base64");

export interface PodcastConfig {
  title: string;
  description: string;
  author: string;
  ownerName: string;
  ownerEmail: string;
  imageUrl: string;       // cover art — square JPEG/PNG, 1400–3000px (Spotify requirement)
  category: string;       // iTunes category, e.g. "Business"
  language: string;       // e.g. "en"
  explicit: boolean;
  siteLink: string;       // public website link
  cptRestBase: string;    // REST base of the podcast custom post type (e.g. "podcast")
  audioField: string;     // ACF field on the CPT holding the episode MP3 URL
}

export function getPodcastConfig(): PodcastConfig {
  return {
    title:          process.env.PODCAST_TITLE          || "Aston VIP Insights",
    description:    process.env.PODCAST_DESCRIPTION    || "Practical guidance on international company formation, banking, tax and corporate structuring from the advisers at Aston VIP.",
    author:         process.env.PODCAST_AUTHOR         || "Aston VIP",
    ownerName:      process.env.PODCAST_OWNER_NAME     || process.env.PODCAST_AUTHOR || "Aston VIP",
    ownerEmail:     process.env.PODCAST_OWNER_EMAIL    || "",
    imageUrl:       process.env.PODCAST_IMAGE_URL      || "",
    category:       process.env.PODCAST_CATEGORY       || "Business",
    language:       process.env.PODCAST_LANGUAGE       || "en",
    explicit:      (process.env.PODCAST_EXPLICIT       || "false").toLowerCase() === "true",
    siteLink:       process.env.PODCAST_SITE_LINK      || "https://aston.ae",
    cptRestBase:    process.env.PODCAST_CPT_REST_BASE  || "podcast",
    audioField:     process.env.PODCAST_CPT_AUDIO_FIELD || "podcast_audio_url",
  };
}

export interface PodcastEpisode {
  id: number;
  title: string;
  description: string;
  link: string;
  guid: string;
  pubDate: string;        // RFC-822
  audioUrl: string;
  audioBytes: number;
  audioType: string;
  imageUrl?: string;
}

// ── XML helpers ───────────────────────────────────────────────
function xmlEscape(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function cdata(s: string): string {
  // Strip the CDATA terminator so untrusted content can't break out.
  return `<![CDATA[${(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
function stripHtml(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function rfc822(dateIso: string): string {
  const d = dateIso ? new Date(dateIso) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

// ── WordPress fetch ───────────────────────────────────────────

/** HEAD the audio URL to get the byte length + MIME for the <enclosure>. */
async function probeAudio(url: string): Promise<{ bytes: number; type: string }> {
  const fallbackType = url.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(6_000) });
    const len = parseInt(res.headers.get("content-length") ?? "0", 10);
    const type = res.headers.get("content-type")?.split(";")[0]?.trim() || fallbackType;
    return { bytes: Number.isFinite(len) ? len : 0, type };
  } catch {
    return { bytes: 0, type: fallbackType };
  }
}

// ── Resilient episode list ────────────────────────────────────
// The public feed is hit by podcast directories' crawlers around the clock,
// and every hit used to reach WordPress live — through SiteGround's anti-bot,
// which challenges Vercel's shared IPs intermittently. When blocked, the
// route either timed out (5-attempt ladder inside a 60s function) or served an
// EMPTY channel, which directories can read as "all episodes removed".
//
// Now: ONE bounded live fetch (2 attempts, 15s each). Success refreshes a
// Redis copy of the episode list; any failure — and an empty result after a
// previously non-empty one — serves that copy instead. Audio probes (HEAD for
// byte length) are reused from the copy so only new episodes are probed.

const RSS_CACHE_KEY = "aston:podcast:rss_cache";

interface RssCache { episodes: PodcastEpisode[]; at: string }

export interface EpisodesResult {
  episodes: PodcastEpisode[];
  source: "live" | "cache" | "empty";
  cachedAt?: string;
  error?: string;
}

type Probe = { bytes: number; type: string };

/** One bounded live fetch of the podcast CPT. Throws on any failure. */
async function fetchLiveEpisodes(config: PodcastConfig, knownProbes: Map<string, Probe>): Promise<PodcastEpisode[]> {
  // Episodes live in the dedicated podcast custom post type (the CPT itself is
  // the curation — no category filter needed). Public/view context exposes the
  // ACF fields without requiring edit rights.
  const res = await fetchWithSgRetry("getPodcastEpisodes", () => fetch(
    `${WP_URL}/wp-json/wp/v2/${config.cptRestBase}?per_page=100&_embed=wp:featuredmedia&orderby=date&order=desc`,
    { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(15_000) }
  ), { maxAttempts: 2 });
  if (!res.ok) throw new Error(`CPT "${config.cptRestBase}" fetch failed: HTTP ${res.status}`);

  // Guard against a captcha page that slipped through as HTTP 200.
  const rawText = await res.text();
  let posts: Array<Record<string, unknown>>;
  try {
    posts = JSON.parse(rawText) as Array<Record<string, unknown>>;
  } catch {
    throw new Error(`CPT "${config.cptRestBase}" returned non-JSON (likely a SiteGround captcha page)`);
  }
  if (!Array.isArray(posts)) throw new Error(`CPT "${config.cptRestBase}" returned an unexpected payload`);

  const episodes = await Promise.all(
    posts.map(async (p): Promise<PodcastEpisode | null> => {
      const acf = (p.acf as Record<string, unknown>) ?? {};
      const audioUrl = typeof acf[config.audioField] === "string" ? (acf[config.audioField] as string).trim() : "";
      if (!audioUrl) return null; // no episode audio → not published

      const title = stripHtml(((p.title as { rendered?: string })?.rendered) ?? "");
      // CPT may not support excerpt — fall back to the content body.
      const excerpt = stripHtml(((p.excerpt as { rendered?: string })?.rendered) ?? "")
        || stripHtml(((p.content as { rendered?: string })?.rendered) ?? "").slice(0, 500);
      const link = (p.link as string) ?? config.siteLink;
      const guid = ((p.guid as { rendered?: string })?.rendered) || link;
      const dateGmt = (p.date_gmt as string) || (p.date as string) || "";
      const featured = (p._embedded as { "wp:featuredmedia"?: Array<{ source_url?: string }> } | undefined)
        ?.["wp:featuredmedia"]?.[0]?.source_url;

      const { bytes, type } = knownProbes.get(audioUrl) ?? await probeAudio(audioUrl);

      return {
        id: (p.id as number) ?? 0,
        title,
        description: excerpt,
        link,
        guid,
        pubDate: rfc822(dateGmt),
        audioUrl,
        audioBytes: bytes,
        audioType: type,
        imageUrl: featured,
      };
    })
  );

  return episodes.filter((e): e is PodcastEpisode => e !== null);
}

/**
 * Curated episodes for the feed: live when WordPress answers, otherwise the
 * last good copy. Never throws — the feed must always render a valid channel.
 */
export async function getPodcastEpisodes(config: PodcastConfig): Promise<EpisodesResult> {
  const cached = await kget<RssCache | null>(RSS_CACHE_KEY, null).catch(() => null);
  const known = new Map<string, Probe>(
    (cached?.episodes ?? [])
      .filter((e) => e.audioBytes > 0)
      .map((e) => [e.audioUrl, { bytes: e.audioBytes, type: e.audioType }])
  );

  try {
    const live = await fetchLiveEpisodes(config, known);
    if (live.length === 0 && cached && cached.episodes.length > 0) {
      // A sudden empty list after a non-empty one is far more likely a
      // WordPress hiccup than a deliberate removal of every episode. Serve the
      // copy and log it; clear the aston:podcast:rss_cache key if the removal
      // was real.
      console.warn(`[podcast] live feed returned no episodes but ${cached.episodes.length} were cached — serving the cached copy`);
      return { episodes: cached.episodes, source: "cache", cachedAt: cached.at, error: "live feed returned no episodes" };
    }
    if (live.length > 0) {
      await kset(RSS_CACHE_KEY, { episodes: live, at: new Date().toISOString() } satisfies RssCache)
        .catch((err) => console.warn(`[podcast] could not cache episodes (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
    }
    return { episodes: live, source: live.length > 0 ? "live" : "empty" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[podcast] live episode fetch failed: ${msg}`);
    if (cached && cached.episodes.length > 0) {
      console.warn(`[podcast] serving ${cached.episodes.length} cached episodes from ${cached.at}`);
      return { episodes: cached.episodes, source: "cache", cachedAt: cached.at, error: msg };
    }
    return { episodes: [], source: "empty", error: msg };
  }
}

// ── Feed builder ──────────────────────────────────────────────

export function buildPodcastRssXml(
  episodes: PodcastEpisode[],
  config: PodcastConfig,
  selfUrl: string
): string {
  const itunesExplicit = config.explicit ? "true" : "false";

  const items = episodes.map((ep) => `
    <item>
      <title>${cdata(ep.title)}</title>
      <description>${cdata(ep.description)}</description>
      <itunes:summary>${cdata(ep.description)}</itunes:summary>
      <link>${xmlEscape(ep.link)}</link>
      <guid isPermaLink="false">${xmlEscape(ep.guid)}</guid>
      <pubDate>${ep.pubDate}</pubDate>
      <enclosure url="${xmlEscape(ep.audioUrl)}" length="${ep.audioBytes}" type="${ep.audioType}" />
      <itunes:explicit>${itunesExplicit}</itunes:explicit>${ep.imageUrl ? `
      <itunes:image href="${xmlEscape(ep.imageUrl)}" />` : ""}
    </item>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${cdata(config.title)}</title>
    <description>${cdata(config.description)}</description>
    <link>${xmlEscape(config.siteLink)}</link>
    <language>${xmlEscape(config.language)}</language>
    <copyright>© ${new Date().getFullYear()} ${xmlEscape(config.author)}</copyright>
    <atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml" />
    <itunes:author>${xmlEscape(config.author)}</itunes:author>
    <itunes:summary>${cdata(config.description)}</itunes:summary>
    <itunes:type>episodic</itunes:type>
    <itunes:explicit>${itunesExplicit}</itunes:explicit>
    <itunes:category text="${xmlEscape(config.category)}" />
    <itunes:owner>
      <itunes:name>${xmlEscape(config.ownerName)}</itunes:name>
      <itunes:email>${xmlEscape(config.ownerEmail)}</itunes:email>
    </itunes:owner>${config.imageUrl ? `
    <itunes:image href="${xmlEscape(config.imageUrl)}" />
    <image>
      <url>${xmlEscape(config.imageUrl)}</url>
      <title>${cdata(config.title)}</title>
      <link>${xmlEscape(config.siteLink)}</link>
    </image>` : ""}${items}
  </channel>
</rss>`;
}
