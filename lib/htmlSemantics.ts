/**
 * lib/htmlSemantics.ts
 * ─────────────────────────────────────────────────────────────
 * Heading-structure guard for generated articles. Pure and Node-free, so the
 * workflow scrub step and QA can both import it.
 *
 * The page template renders the article title as the only H1, the sections as
 * H3 and their subsections as H4. The allowed HTML for every field is stated
 * in the prompts, but until 2026-10 nothing enforced it, and the model broke
 * the outline in ways nobody saw until a client looked at the source:
 *  - <h1>{focus keyword}</h1> at the top of Key takeaways (posts 71421, 71521,
 *    71641) — a second H1 on the page;
 *  - the definition term written as an <h4> before any H3 (post 71505);
 *  - chart and infographic titles were <h4> by template, so they appeared in
 *    the outline and table of contents as fake subsections;
 *  - FAQ questions were <h3>, level with the main sections, under no heading.
 *
 * normaliseArticleHtml() repairs all of these deterministically before QA and
 * publish; findHeadingIssues() is the QA check that reports anything it could
 * not repair.
 */

import type { BlogContent } from "./wordpress";

/** The H3 that introduces the FAQ; the questions sit under it as H4s. */
export const FAQ_HEADING = "Frequently asked questions";

/** Fields that hold article sections: H3 sections with H4 subsections. */
const SECTION_FIELDS = [
  "main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_6",
] as const;

/** Fields that must never contain a heading (lists and plain-text callouts). */
const NO_HEADING_FIELDS = [
  "key_takeaways", "final_points", "keypoint_one", "keypoint_two", "quote_1", "quote_2", "excerpt",
] as const;

const HEADING_RE = /<(h[1-6])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const BLOCK_TITLE_CLASS_RE = /class="[^"]*\baston-(?:visual-block|chart-block)__title\b/i;
const FAQ_TITLE_RE = /^(?:faqs?|frequently asked questions)\b/i;

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const levelOf = (tag: string) => Number(tag.slice(1));

function removeHeadings(html: string): string {
  return html.replace(HEADING_RE, "").replace(/^\s*\n/, "");
}

/** Chart / infographic titles: a styled caption, not a heading. */
function blockTitlesToParagraphs(html: string): string {
  return html.replace(HEADING_RE, (m, _tag: string, attrs: string, inner: string) =>
    BLOCK_TITLE_CLASS_RE.test(attrs) ? `<p${attrs}>${inner}</p>` : m);
}

/** Apply `fn` to the inside of every <div class="… {cls} …"> (these blocks never nest divs). */
function mapBlock(html: string, cls: string, fn: (inner: string) => string): string {
  const re = new RegExp(`(<div\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>)([\\s\\S]*?)(<\\/div>)`, "gi");
  return html.replace(re, (_m, open: string, inner: string, close: string) => open + fn(inner) + close);
}

/** Definition term → <strong class="aston-definition__term">; no label heading in the quick answer. */
function repairAnswerBlocks(html: string): string {
  let out = mapBlock(html, "aston-definition", (inner) =>
    inner.replace(HEADING_RE, (_m, _t, _a, text: string) => `<strong class="aston-definition__term">${textOf(text)}</strong>`));
  out = mapBlock(out, "aston-quick-answer", removeHeadings);
  return out;
}

/**
 * Section fields: no H1/H2 (the page owns the H1), no H6, no empty headings,
 * and no H4 before the field's first H3 (that skips a level under the H1).
 */
function normaliseSectionHeadings(html: string): string {
  let seenH3 = false;
  return html.replace(HEADING_RE, (_m, tag: string, attrs: string, inner: string) => {
    if (!textOf(inner)) return "";
    let level = levelOf(tag);
    if (level <= 2) level = 3;
    if (level === 6) level = 5;
    if (level >= 4 && !seenH3) level = 3;
    if (level === 3) seenH3 = true;
    return `<h${level}${attrs}>${inner}</h${level}>`;
  });
}

/** FAQ: one H3 for the block, every question an H4 beneath it. */
function normaliseFaq(html: string): string {
  if (!textOf(html)) return html;
  const body = html
    .replace(HEADING_RE, (_m, _tag: string, attrs: string, inner: string) => {
      const t = textOf(inner);
      if (!t || FAQ_TITLE_RE.test(t)) return "";
      return `<h4${attrs}>${inner}</h4>`;
    })
    .trim();
  return `<h3>${FAQ_HEADING}</h3>\n${body}`;
}

/**
 * Repair the heading structure of every content field. Idempotent. Returns the
 * repaired content and one line per field that changed, for the run log.
 */
export function normaliseArticleHtml<T extends Partial<BlogContent>>(content: T): { content: T; changes: string[] } {
  const out = { ...content } as Record<string, unknown>;
  const changes: string[] = [];
  const apply = (field: string, fn: (html: string) => string) => {
    const before = out[field];
    if (typeof before !== "string" || !before) return;
    const after = fn(before);
    if (after !== before) {
      out[field] = after;
      changes.push(field);
    }
  };

  for (const f of SECTION_FIELDS) {
    apply(f, (h) => normaliseSectionHeadings(repairAnswerBlocks(blockTitlesToParagraphs(h))));
  }
  apply("more_content_5", (h) => normaliseFaq(blockTitlesToParagraphs(h)));
  for (const f of NO_HEADING_FIELDS) apply(f, removeHeadings);

  return { content: out as T, changes };
}

/**
 * Heading-structure problems in the content, as human-readable lines (empty
 * when the outline is sound). Used by QA after normaliseArticleHtml has run,
 * so anything reported here is a pattern the repair does not cover.
 */
export function findHeadingIssues(content: Partial<BlogContent>): string[] {
  const issues: string[] = [];
  const rec = content as Record<string, unknown>;
  const html = (f: string) => (typeof rec[f] === "string" ? (rec[f] as string) : "");
  const headings = (h: string) => [...h.matchAll(HEADING_RE)].map((m) => ({ level: levelOf(m[1]), attrs: m[2], text: textOf(m[3]) }));

  for (const f of NO_HEADING_FIELDS) {
    const hs = headings(html(f));
    if (hs.length) issues.push(`${f} contains a heading (<h${hs[0].level}> "${hs[0].text.slice(0, 40)}")`);
  }
  for (const f of [...SECTION_FIELDS, "more_content_5"]) {
    const hs = headings(html(f));
    if (hs.some((h) => h.level <= 2)) issues.push(`${f} contains an H1 or H2 — the page title is the only H1`);
    if (hs.some((h) => !h.text)) issues.push(`${f} has an empty heading`);
    if (hs.some((h) => BLOCK_TITLE_CLASS_RE.test(h.attrs))) issues.push(`${f} uses a heading for a chart or infographic title`);
    const firstH3 = hs.findIndex((h) => h.level === 3);
    if (hs.some((h, i) => h.level >= 4 && (firstH3 === -1 || i < firstH3))) issues.push(`${f} has an H4 before any H3`);
  }
  for (const cls of ["aston-definition", "aston-quick-answer"]) {
    for (const f of SECTION_FIELDS) {
      let found = false;
      mapBlock(html(f), cls, (inner) => { if (headings(inner).length) found = true; return inner; });
      if (found) issues.push(`${f} has a heading inside the ${cls} block`);
    }
  }
  const faq = headings(html("more_content_5"));
  if (faq.length && (faq[0].level !== 3 || !FAQ_TITLE_RE.test(faq[0].text) || faq.slice(1).some((h) => h.level !== 4))) {
    issues.push("more_content_5 questions must be H4s under one FAQ H3");
  }
  return [...new Set(issues)];
}

/** FAQ field without its block heading — for narration, which adds its own lead-in. */
export function stripFaqHeading(html: string): string {
  return html.replace(HEADING_RE, (m, _t, _a, inner: string) => (FAQ_TITLE_RE.test(textOf(inner)) ? "" : m));
}
