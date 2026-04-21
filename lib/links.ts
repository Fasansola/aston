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
 * Returns structured link objects ready to be injected into the prompt.
 */
export async function selectLinks(topic: string): Promise<SelectedLinks> {
  const all = await getLinks();

  const activeInternal = all.filter((l) => l.type === "internal" && l.status === "active");
  const activeExternal = all.filter((l) => l.type === "external" && l.status === "active");

  // Score every internal link
  const scoredInternal = activeInternal
    .map((link) => ({ link, score: scoreLinkForTopic(link, topic) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  // Pick top-scoring internal links — max 2 per category, up to 15 total
  const categoryCount = new Map<string, number>();
  const selectedInternal: SelectedLink[] = [];

  for (const { link } of scoredInternal) {
    if (selectedInternal.length >= 15) break;
    const count = categoryCount.get(link.category) ?? 0;
    if (count >= 2) continue;

    categoryCount.set(link.category, count + 1);
    selectedInternal.push({ url: link.url, title: link.title, anchors: link.anchors });
  }

  // Backfill to 8 from unscored links, max 2 per category
  if (selectedInternal.length < 8) {
    const usedUrls = new Set(selectedInternal.map((l) => l.url));
    const unscored = activeInternal.filter((l) => !usedUrls.has(l.url));
    for (const link of unscored) {
      if (selectedInternal.length >= 8) break;
      const count = categoryCount.get(link.category) ?? 0;
      if (count >= 2) continue;
      categoryCount.set(link.category, count + 1);
      selectedInternal.push({ url: link.url, title: link.title, anchors: link.anchors });
    }
  }

  // Score every external link — cap at 2
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
 */
export function formatLinksForPrompt(links: SelectedLinks): string {
  const internalLines = links.internal
    .map((l) => `- ${l.url}\n  Anchor options: ${l.anchors.join(" | ")}`)
    .join("\n");

  const externalLines = links.external
    .map((l) => `- ${l.url}\n  Anchor options: ${l.anchors.join(" | ")}`)
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
- Write every internal link as HTML: <a href="/url">anchor text</a>
- In your JSON response, report every link used in "internal_links_used" and "external_links_used" arrays`;
}
