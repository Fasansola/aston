/**
 * app/api/links/sync-wp/route.ts
 * POST /api/links/sync-wp
 *
 * Fetches all published posts from the WordPress REST API and merges them
 * into the internal links pool stored in KV. Existing entries (matched by
 * URL) are skipped so manual edits are never overwritten. New posts are
 * added with keywords and anchors derived from the post title and Yoast
 * focus keyword.
 */

import { NextRequest, NextResponse } from "next/server";
import { getLinks, saveLinks, LinkEntry } from "@/lib/storage";
import axios from "axios";

export const maxDuration = 60;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","up","about","into","through","your","our","their","its",
  "how","what","why","when","where","which","who","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","will","would",
  "could","should","may","might","must","can","vs","vs.","all","get","new",
]);

// Map WordPress category IDs → our category slugs
const WP_CAT_TO_SLUG: Record<number, string> = {
  284: "adgm",
  291: "abu-dhabi",
  447: "offshore",
  287: "dfsa-difc",
  276: "dfsa-difc",
  278: "vara",
  282: "crypto",
  86:  "crypto",
  19:  "tax",
  17:  "banking",
  20:  "company-formation",
  29:  "startups",
  30:  "economic-zones",
  280: "business",
  18:  "uae",
  113: "general",
};

/** Derive up to 8 searchable keyword phrases from a post title + focus keyword. */
function deriveKeywords(rawTitle: string, focusKeyword: string): string[] {
  const kws: string[] = [];

  if (focusKeyword?.trim()) {
    kws.push(focusKeyword.toLowerCase().trim());
  }

  // Clean HTML entities from title
  const title = rawTitle
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();

  const words = title.split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Bigrams
  for (let i = 0; i + 1 < words.length; i++) {
    kws.push(`${words[i]} ${words[i + 1]}`);
  }
  // Trigrams
  for (let i = 0; i + 2 < words.length; i++) {
    kws.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }

  return [...new Set(kws)].slice(0, 8);
}

/** Pick the best category slug from WP category IDs, ordered by specificity. */
function deriveCategory(categoryIds: number[]): string {
  // Iterate in specificity order (most specific categories first)
  const order = [284,291,447,287,276,278,282,86,19,17,20,29,30,280,18,113];
  for (const id of order) {
    if (categoryIds.includes(id)) return WP_CAT_TO_SLUG[id];
  }
  return "general";
}

/** Fetch one page of posts from WordPress. Returns posts + total page count. */
async function fetchWpPage(
  baseUrl: string,
  auth: string,
  page: number
): Promise<{ posts: WpPost[]; totalPages: number }> {
  const url = `${baseUrl}/wp-json/wp/v2/posts?per_page=100&status=publish&context=edit&page=${page}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      "User-Agent": "AstonBlogTool/1.0 (Vercel; +https://aston.ae)",
    },
  });
  const totalPages = parseInt(res.headers["x-wp-totalpages"] ?? "1", 10);
  return { posts: res.data as WpPost[], totalPages };
}

interface WpPost {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  categories: number[];
  meta: { _yoast_wpseo_focuskw?: string };
  lang?: string; // Polylang adds this field — ISO 639-1 code e.g. "en", "fr"
}

/**
 * Detect the language code for a post.
 * 1. Use Polylang's `lang` field if present on the post object.
 * 2. Fall back to URL pattern: /language/{code}/ or /{code}/ prefix.
 * 3. If nothing matches, return undefined (treated as default/all languages).
 */
function detectLanguage(post: WpPost): string | undefined {
  if (post.lang?.trim()) return post.lang.trim().toLowerCase();

  // URL-based detection — Polylang directory method variants
  const url = post.link;
  const langDirMatch = url.match(/\/language\/([a-z]{2,5})\//i);
  if (langDirMatch) return langDirMatch[1].toLowerCase();

  const prefixMatch = url.match(/https?:\/\/[^/]+\/([a-z]{2,5})\//i);
  if (prefixMatch) {
    const candidate = prefixMatch[1].toLowerCase();
    // Exclude common path segments that are not language codes
    const NOT_LANG = new Set(["wp", "api", "wp-json", "wp-admin", "wp-content", "category", "tag", "page"]);
    if (!NOT_LANG.has(candidate) && candidate.length <= 5) return candidate;
  }

  return undefined;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const WP_URL      = process.env.WP_URL!;
  const WP_USERNAME = process.env.WP_USERNAME!;
  const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

  try {
    // ── Fetch all published posts from WordPress ─────────────
    const allPosts: WpPost[] = [];
    const { posts: firstPage, totalPages } = await fetchWpPage(WP_URL, auth, 1);
    allPosts.push(...firstPage);

    for (let page = 2; page <= totalPages; page++) {
      const { posts } = await fetchWpPage(WP_URL, auth, page);
      allPosts.push(...posts);
    }

    console.log(`[sync-wp] Fetched ${allPosts.length} published posts across ${totalPages} pages`);

    // ── Load existing links and build indexes ────────────────
    const existing = await getLinks();
    const existingByUrl = new Map(
      existing.map((l) => [l.url.replace(/\/$/, "").toLowerCase(), l])
    );

    const newLinks: LinkEntry[] = [];
    let languagePatched = 0;

    for (const post of allPosts) {
      const fullUrl   = post.link.replace(/\/$/, "");
      const normalised = fullUrl.toLowerCase();
      const language  = detectLanguage(post);

      const existing_entry = existingByUrl.get(normalised);

      if (existing_entry) {
        // Backfill language on existing links that were synced before this feature
        if (language && !existing_entry.language) {
          existing_entry.language = language;
          languagePatched++;
        }
        continue;
      }

      const title    = post.title.rendered.replace(/<[^>]+>/g, "").trim();
      const focusKw  = post.meta?._yoast_wpseo_focuskw?.trim() ?? "";
      const keywords = deriveKeywords(title, focusKw);
      const category = deriveCategory(post.categories ?? []);
      const anchors  = [title];
      if (focusKw && focusKw.toLowerCase() !== title.toLowerCase()) {
        anchors.push(focusKw);
      }

      newLinks.push({
        id:       `wp_${post.id}`,
        url:      post.link,
        title,
        type:     "internal",
        category,
        keywords,
        anchors,
        status:   "active",
        ...(language ? { language } : {}),
      });

      existingByUrl.set(normalised, newLinks[newLinks.length - 1]);
    }

    if (newLinks.length > 0 || languagePatched > 0) {
      await saveLinks([...existing, ...newLinks]);
    }

    console.log(`[sync-wp] Added ${newLinks.length} new links, patched language on ${languagePatched} existing (${allPosts.length - newLinks.length} already existed)`);

    return NextResponse.json({
      added:           newLinks.length,
      languagePatched,
      skipped:         allPosts.length - newLinks.length - languagePatched,
      total:           existing.length + newLinks.length,
    });

  } catch (err: unknown) {
    console.error("[sync-wp] Error:", err);
    const msg = axios.isAxiosError(err)
      ? `WordPress API error (${err.response?.status}): ${JSON.stringify(err.response?.data ?? err.message)}`
      : err instanceof Error ? err.message : "Sync failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
