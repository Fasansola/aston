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

const WP_URL = process.env.WP_URL!;
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
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const len = parseInt(res.headers.get("content-length") ?? "0", 10);
    const type = res.headers.get("content-type")?.split(";")[0]?.trim() || fallbackType;
    return { bytes: Number.isFinite(len) ? len : 0, type };
  } catch {
    return { bytes: 0, type: fallbackType };
  }
}

/**
 * Fetch curated episodes: posts in the configured category that have an
 * audio_url, newest first. Non-fatal — returns [] on failure so the feed still
 * renders a valid (empty) channel rather than erroring out for Spotify.
 */
export async function getPodcastEpisodes(config: PodcastConfig): Promise<PodcastEpisode[]> {
  try {
    // Episodes live in the dedicated podcast custom post type (the CPT itself is
    // the curation — no category filter needed). Public/view context exposes the
    // ACF fields without requiring edit rights.
    const res = await fetch(
      `${WP_URL}/wp-json/wp/v2/${config.cptRestBase}?per_page=100&_embed=wp:featuredmedia&orderby=date&order=desc`,
      { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(20_000) }
    );
    if (!res.ok) {
      console.warn(`[podcast] CPT "${config.cptRestBase}" fetch failed: ${res.status}`);
      return [];
    }
    const posts = (await res.json()) as Array<Record<string, unknown>>;

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

        const { bytes, type } = await probeAudio(audioUrl);

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
  } catch (err) {
    console.error(`[podcast] getPodcastEpisodes failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
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
