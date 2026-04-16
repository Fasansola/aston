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

  // Pick top-scoring internal links — max one per category
  const usedCategories = new Set<string>();
  const selectedInternal: SelectedLink[] = [];

  for (const { link } of scoredInternal) {
    if (selectedInternal.length >= 5) break;
    if (usedCategories.has(link.category)) continue;

    usedCategories.add(link.category);
    selectedInternal.push({ url: link.url, title: link.title, anchors: link.anchors });
  }

  // Backfill to 3 from unscored links across unused categories
  if (selectedInternal.length < 3) {
    const unscored = activeInternal.filter((l) => !usedCategories.has(l.category));
    for (const link of unscored) {
      if (selectedInternal.length >= 3) break;
      usedCategories.add(link.category);
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

  return `INTERNAL LINKS — include 3-5 naturally within body content using the suggested anchor text (or a natural variant). Only use URLs from this list. Do not invent URLs:\n${internalLines}${externalBlock}

LINK RULES:
- Place links in the body text of more_content_1 through more_content_4
- Use the suggested anchor text or a close natural variant — never bare URLs
- Do not force irrelevant links into the text; relevance over quantity
- Do not link the same URL more than once
- In your JSON response, report which links you used in "internal_links_used" and "external_links_used" arrays`;
}
