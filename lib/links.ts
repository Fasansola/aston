/**
 * lib/links.ts
 * ─────────────────────────────────────────────────────────────
 * Link Manager — selects the most relevant internal and external
 * links for a given blog topic, then formats them for the prompt.
 *
 * Selection rules:
 *  - Score each link by keyword matches against the topic
 *  - Pick top 3-5 internal links, max one per category
 *  - Pick top 0-2 external links
 */

import { getLinks, type LinkEntry } from "@/lib/storage";

// ── Types ─────────────────────────────────────────────────────

export interface SelectedLink {
  url: string;
  title: string;
  anchors: string[];
}

export interface SelectedLinks {
  internal: SelectedLink[];
  external: SelectedLink[];
}

// ── Scoring ───────────────────────────────────────────────────

function scoreLinkForTopic(link: LinkEntry, topic: string): number {
  const needle = topic.toLowerCase();
  let score = 0;

  for (const keyword of link.keywords) {
    if (needle.includes(keyword.toLowerCase())) {
      score += keyword.split(" ").length;
    }
  }

  return score;
}

// ── Main export ───────────────────────────────────────────────

/**
 * Select the most relevant internal and external links for a topic.
 * When a language code is provided, internal links are filtered to only
 * include links tagged with that language OR with no language tag (legacy/untagged).
 * External links are never filtered by language.
 */
const ENGLISH_CODES = new Set(["en", "en-gb", "en-us"]);

export async function selectLinks(topic: string, language?: string): Promise<SelectedLinks> {
  const all = await getLinks();

  const lang = language?.trim().toLowerCase() || undefined;

  const allInternal = all.filter((l) => l.type === "internal" && l.status === "active");

  // When a language is requested: primary pool = that language only.
  // Fallback pool = English-tagged + untagged (legacy) links, used only if
  // the primary pool can't fill the minimum slot count.
  // When no language is requested: use all links with no separation.
  let primaryPool: LinkEntry[];
  let fallbackPool: LinkEntry[];

  if (lang) {
    primaryPool  = allInternal.filter((l) => l.language?.toLowerCase() === lang);
    const primaryUrls = new Set(primaryPool.map((l) => l.url));
    fallbackPool = allInternal.filter(
      (l) => !primaryUrls.has(l.url) && (!l.language || ENGLISH_CODES.has(l.language.toLowerCase()))
    );
  } else {
    primaryPool  = allInternal;
    fallbackPool = [];
  }

  const categoryCount = new Map<string, number>();
  const selectedInternal: SelectedLink[] = [];

  function pickFromPool(pool: LinkEntry[], limit: number) {
    const scored = pool
      .map((link) => ({ link, score: scoreLinkForTopic(link, topic) }))
      .sort((a, b) => b.score - a.score);

    // Scored first, then unscored, so relevance is preserved within the pool
    const ordered = [
      ...scored.filter(({ score }) => score > 0),
      ...scored.filter(({ score }) => score === 0),
    ];

    const usedUrls = new Set(selectedInternal.map((l) => l.url));
    for (const { link } of ordered) {
      if (selectedInternal.length >= limit) break;
      if (usedUrls.has(link.url)) continue;
      const count = categoryCount.get(link.category) ?? 0;
      if (count >= 2) continue;
      categoryCount.set(link.category, count + 1);
      selectedInternal.push({ url: link.url, title: link.title, anchors: link.anchors });
      usedUrls.add(link.url);
    }
  }

  // Fill from primary language pool up to 15
  pickFromPool(primaryPool, 15);

  // If below 8, backfill from English/untagged fallback
  if (selectedInternal.length < 8 && fallbackPool.length > 0) {
    pickFromPool(fallbackPool, 8);
  }

  // Score every external link — cap at 2
  const activeExternal = all.filter((l) => l.type === "external" && l.status === "active");
  const selectedExternal: SelectedLink[] = activeExternal
    .map((link) => ({ link, score: scoreLinkForTopic(link, topic) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(({ link }) => ({ url: link.url, title: link.title, anchors: link.anchors }));

  return { internal: selectedInternal, external: selectedExternal };
}

/**
 * Format selected links into the block injected into the GPT prompt.
 * When a non-English language is provided, the model is instructed to write
 * its own anchor text in that language rather than using the English suggestions.
 */
export function formatLinksForPrompt(links: SelectedLinks, language?: string): string {
  const isNonEnglish = !!language && !["en", "en-gb", "en-us"].includes(language.toLowerCase());

  const anchorNote = isNonEnglish
    ? `  (anchor suggestions are in English — write your own natural anchor text in ${language} instead)`
    : "";

  const internalLines = links.internal
    .map((l) => `- ${l.url}\n  Anchor options: ${l.anchors.join(" | ")}${anchorNote}`)
    .join("\n");

  const externalLines = links.external
    .map((l) => `- ${l.url}\n  Anchor options: ${l.anchors.join(" | ")}${anchorNote}`)
    .join("\n");

  const externalBlock =
    links.external.length > 0
      ? `\nEXTERNAL LINKS — include 1-2 where genuinely relevant:\n${externalLines}`
      : "";

  return `INTERNAL LINKS — target 7 to 15 links spread across the full article (3 to 10 per 1,000 words). Only use URLs from this list. Do not invent URLs:\n${internalLines}${externalBlock}

LINK RULES:
- Spread links across main_content, more_content_1, more_content_2, more_content_3, more_content_4, more_content_6, and key_takeaways — not just 1 or 2 sections
- Use the suggested anchor text or a close natural variant — never bare URLs
- Each link must sit naturally inside a sentence and support the point being made
- Do not force irrelevant links into the text; relevance matters
- Do not link the same URL more than twice across the full article
- Write every internal link as HTML using the exact URL provided: <a href="https://aston.ae/page-slug/">anchor text</a>
- In your JSON response, report every link used in "internal_links_used" and "external_links_used" arrays`;
}
