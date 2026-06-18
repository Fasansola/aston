/**
 * lib/qa.ts
 * ─────────────────────────────────────────────────────────────
 * QA Engine — validates the assembled post before it is pushed
 * to WordPress.
 *
 * Checks fall into two buckets:
 *  - Blocking: post must NOT be created if any of these fail
 *  - Warnings: post is created as draft but issues are flagged
 *
 * Returns a structured report with status, score, per-check
 * results, warning messages, and blocking issue descriptions.
 */

import { BlogContent, ImagePrompts } from "./wordpress";

/**
 * Checks that are NOT hard-blocking (a failure won't discard the article)
 * but ARE important enough to trigger a targeted fix pass when they fail.
 * If they remain unfixed after the final QA attempt, the post still publishes
 * with the failure recorded as a warning — we never lose a finished article
 * over these, but we always attempt to fix them first.
 *
 * All listed checks must have a CHECK_TO_FIELDS mapping in lib/openai.ts so
 * fixBlogContent knows which fields to rewrite.
 */
export const RETRYABLE_WARNING_CHECKS = [
  "quick_answer_block_exists",
  "definition_block_exists",
  "sentence_length_ok",
  "no_us_spellings",
  "seo_title_focused",
  "headings_specific",
] as const;

export interface QAReport {
  status: "pass" | "warn" | "fail";
  score: number;
  wordCount: number;
  checks: Record<string, boolean>;
  warnings: string[];
  blocking_issues: string[];
}

// ── Helpers ───────────────────────────────────────────────────

function stripHtml(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function countWords(html: string): number {
  const text = stripHtml(html);
  return text.length === 0 ? 0 : text.split(" ").filter((w) => w.length > 0).length;
}

function countTag(html: string, tag: string): number {
  return ((html ?? "").match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
}

function plainIncludes(html: string, phrase: string): boolean {
  return stripHtml(html).toLowerCase().includes(phrase.toLowerCase());
}

function extractHeadingText(html: string): string[] {
  return ((html ?? "").match(/<h[2-5][^>]*>(.*?)<\/h[2-5]>/gi) ?? []).map(
    (h) => stripHtml(h).toLowerCase()
  );
}

/**
 * Mirrors Yoast's sentence-length check.
 * Returns the percentage of sentences that exceed 20 words.
 * Yoast issues a warning when this exceeds 25%.
 */
function longSentencePercent(html: string): number {
  const text = stripHtml(html);
  if (!text) return 0;
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return 0;
  const long = sentences.filter(
    (s) => s.split(/\s+/).filter((w) => w.length > 0).length > 20
  ).length;
  return Math.round((long / sentences.length) * 100);
}

const BANNED_PHRASES = [
  "seamless",
  "hassle-free",
  "empower",
  "cutting-edge",
  "innovative solution",
  "game-changing",
  "leverage",
  "next-gen",
  "disrupt",
  "frictionless",
  "one-stop-shop",
  "streamline",
  "robust",
  "comprehensive suite",
  "tailored solutions",
  "look no further",
  "unlock",
  "in conclusion",
  "in today's landscape",
  "it's worth noting",
  "dive into",
  "best practices",
  "state-of-the-art",
  "world-class",
  "at the end of the day",
  "it goes without saying",
];

const US_SPELLINGS = [
  "organization",
  "optimization",
  "authorization",
  "centralize",
  "recognize",
  "realize",
  "traveling",
  "modeling",
];

// House style violations — these must never appear regardless of language
const HOUSE_STYLE_VIOLATIONS = [
  "licence",    // must always be written as "license"
  "licences",
  "licenced",
  "licencing",
];

// Ambiguous / double-meaning terms that must not appear in the SEO title.
// "bank checks" reads as cheques as easily as banking due diligence.
const AMBIGUOUS_TITLE_TERMS = ["bank check", "bank checks"];

// Generic, low-SEO headings the model must replace with specific, keyword-bearing ones.
const GENERIC_HEADINGS = new Set([
  "key considerations", "what the process involves", "practical scenarios to plan for",
  "practical scenarios", "common mistakes to avoid", "common mistakes", "overview",
  "introduction", "what you need to know", "how it works", "getting started",
  "key points", "things to consider", "the basics", "key takeaways aside",
]);

function hasColonInHeadings(html: string): boolean {
  const headings = (html ?? "").match(/<h[2-5][^>]*>(.*?)<\/h[2-5]>/gi) ?? [];
  return headings.some((h) => stripHtml(h).includes(":"));
}

function hasDashInTitle(title: string): boolean {
  // Detect em dash, en dash, or standalone hyphen surrounded by spaces in a title
  return /\s[—–-]\s/.test(title) || /[—–]/.test(title);
}

// ── Main QA function ──────────────────────────────────────────

export function runQA(
  content: BlogContent,
  imagePrompts: ImagePrompts,
  imageIds: {
    keypointOneImg: number;
    keypointTwoImg: number;
    postSplitImg: number;
    featuredImg: number;
  },
  title?: string
): QAReport {
  const checks: Record<string, boolean> = {};
  const warnings: string[] = [];
  const blocking_issues: string[] = [];

  // Combined body for aggregate checks
  const bodyFields = [
    content.main_content,
    content.more_content_1,
    content.more_content_2,
    content.more_content_3,
    content.more_content_4,
  ].join(" ");

  const allFields = [
    bodyFields,
    content.key_takeaways,
    content.more_content_5,
    content.more_content_6,
    content.final_points,
    content.keypoint_one,
    content.keypoint_two,
    content.quote_1,
    content.quote_2,
    content.excerpt,
  ].join(" ");

  // Normalise British "licence" → house-style "license" on BOTH sides of every
  // keyword comparison. Otherwise a focus keyword like "UAE trade licence" can
  // never match the "license"-corrected title, and focus_keyword_in_title (a
  // blocking check) fails on every attempt — discarding the whole article.
  const houseStyle = (s: string) => s.replace(/\blicenc(e|es|ed|ing)\b/gi, "licens$1");
  const kw = houseStyle((content.focus_keyword ?? "").toLowerCase());

  // ── BLOCKING CHECKS ───────────────────────────────────────
  // Any failure here prevents the WordPress post from being created.

  // Required SEO fields
  checks.focus_keyword_exists = !!content.focus_keyword?.trim();
  checks.seo_title_exists = !!content.seo_title?.trim();
  checks.meta_description_exists = !!content.meta_description?.trim();
  checks.slug_exists = /^[a-z0-9-]+$/.test(content.slug ?? "");
  checks.excerpt_exists = !!content.excerpt?.trim();

  // Required content sections
  const mainContentWordCount = stripHtml(content.main_content ?? "").trim().split(/\s+/).filter(Boolean).length;
  checks.main_content_exists = mainContentWordCount >= 270;

  // main_content must always contain one internal and one external link
  // Matches both relative (/page) and absolute aston.ae URLs
  checks.main_content_has_internal_link = /href="(\/|https?:\/\/(?:www\.)?aston\.ae)/.test(content.main_content ?? "");
  checks.main_content_has_external_link = /href="https?:\/\//.test(content.main_content ?? "");
  if (!checks.main_content_has_internal_link)
    warnings.push("main_content is missing an internal link");
  if (!checks.main_content_has_external_link)
    warnings.push("main_content is missing an external link");
  checks.key_takeaways_exists = !!content.key_takeaways?.trim();
  checks.more_content_5_exists = !!content.more_content_5?.trim();
  checks.final_points_exists = !!content.final_points?.trim();

  // CTA: more_content_4 must contain the contact link
  checks.cta_exists =
    (content.more_content_4 ?? "").includes("aston.ae/contact-us/");

  // Advisory disclaimer: more_content_4 must state that outcomes are not guaranteed.
  // Warning only — flags a legal/compliance gap without discarding the article.
  checks.disclaimer_exists = /\b(do not|does not|cannot|can not)\s+guarantee\b/i.test(
    content.more_content_4 ?? ""
  );
  if (!checks.disclaimer_exists)
    warnings.push("Advisory disclaimer missing from more_content_4 — must state Aston VIP does not guarantee specific outcomes");

  // Internal links: minimum 7 (document target: 3-10 per 1,000 words)
  checks.internal_links_sufficient =
    (content.internal_links_used?.length ?? 0) >= 7;
  if (!checks.internal_links_sufficient)
    warnings.push(`Only ${content.internal_links_used?.length ?? 0} internal links (target 7+)`);

  // Images uploaded
  checks.featured_image_exists = (imageIds.featuredImg ?? 0) > 0;
  checks.section_images_exist =
    (imageIds.keypointOneImg ?? 0) > 0 &&
    (imageIds.keypointTwoImg ?? 0) > 0 &&
    (imageIds.postSplitImg ?? 0) > 0;

  // Alt text on all images
  checks.image_alt_text_exists =
    !!(imagePrompts.keypoint_one_img_alt?.trim()) &&
    !!(imagePrompts.keypoint_two_img_alt?.trim()) &&
    !!(imagePrompts.post_split_img_alt?.trim()) &&
    !!(imagePrompts.featured_img_alt?.trim());

  // Focus keyword in SEO title
  checks.focus_keyword_in_title = kw
    ? houseStyle((content.seo_title ?? "").toLowerCase()).includes(kw)
    : false;

  // ── WARNING CHECKS ────────────────────────────────────────
  // Failures here produce warnings but do not block publishing.

  // Total word count — warning only, does not block publishing
  const wordCount = countWords(allFields);
  checks.word_count_in_range = wordCount >= 2100 && wordCount <= 5500;
  if (wordCount < 2100)
    warnings.push(`Word count low: ${wordCount} words (minimum 2,100)`);
  else if (wordCount > 5500)
    warnings.push(`Word count high: ${wordCount} words (maximum 5,500)`);

  // H3 section count (minimum 4 across body fields)
  const h3Count = countTag(bodyFields, "h3");
  checks.h3_count_sufficient = h3Count >= 4;
  if (h3Count < 4)
    warnings.push(
      `Only ${h3Count} H3 headings found across body (minimum 4)`
    );

  // H4 subsection count (minimum 6 across body fields)
  const h4Count = countTag(bodyFields, "h4");
  checks.h4_count_sufficient = h4Count >= 6;
  if (h4Count < 6)
    warnings.push(`Only ${h4Count} H4 subsections found (minimum 6)`);

  // Focus keyword in intro (first 300 plain-text chars of main_content)
  const introText = houseStyle(stripHtml(content.main_content ?? "").slice(0, 300).toLowerCase());
  checks.focus_keyword_in_intro = kw ? introText.includes(kw) : false;
  if (!checks.focus_keyword_in_intro && kw)
    warnings.push(`Focus keyword "${content.focus_keyword}" not found in intro`);

  // Focus keyword in at least one section heading.
  // Uses word-overlap (≥50% of keyword words present) so partial matches like
  // "DFSA Tokenisation Sandbox" pass for keyword "dfsa tokenisation regulatory sandbox".
  const headings = extractHeadingText(bodyFields).map(houseStyle);
  const kwWords = kw ? kw.split(/\s+/).filter(Boolean) : [];
  const headingMatchesKw = (h: string) => {
    if (!kwWords.length) return false;
    const matched = kwWords.filter((w) => h.includes(w)).length;
    return matched / kwWords.length >= 0.5;
  };
  checks.focus_keyword_in_heading = kw
    ? headings.some(headingMatchesKw)
    : false;
  if (!checks.focus_keyword_in_heading && kw)
    warnings.push("Focus keyword not found in any section heading");

  // Headings must be specific, not generic filler. Check every H3/H4 across the
  // body (incl. more_content_6) against the generic-heading denylist.
  const headingsForSpecificity = extractHeadingText(
    [bodyFields, content.more_content_6].join(" ")
  ).map((h) => h.trim());
  const genericHeadings = headingsForSpecificity.filter((h) => GENERIC_HEADINGS.has(h));
  checks.headings_specific = genericHeadings.length === 0;
  if (!checks.headings_specific)
    warnings.push(`Generic heading(s) found: "${[...new Set(genericHeadings)].join('", "')}" — rewrite as specific, keyword-bearing headings`);

  // ── AI SEARCH OPTIMISATION CHECKS ────────────────────────
  // Validate the two mandatory structured blocks for Google AI Overviews,
  // featured snippets, and LLM crawlers.
  // NOTE: the label element was removed from these blocks by client request —
  // only the content (aston-quick-answer__text, aston-definition__text) renders.

  // Quick answer block — must be in main_content
  checks.quick_answer_block_exists = (content.main_content ?? "").includes('class="aston-quick-answer"');
  if (!checks.quick_answer_block_exists)
    warnings.push("Quick answer block missing from main_content — required for Google AI Overviews and featured snippets");

  // Definition block — must be in main_content or more_content_1
  const definitionSearchArea = (content.main_content ?? "") + (content.more_content_1 ?? "");
  checks.definition_block_exists = definitionSearchArea.includes('class="aston-definition"');
  if (!checks.definition_block_exists)
    warnings.push("Definition block missing from main_content/more_content_1 — required for entity disambiguation and AI search");

  // Flowchart placeholder — [FLOWCHART_IMG] must appear in a body section
  // (rendered to a Mermaid PNG image in the image generation phase).
  // Also accept aston-timeline for backward compat with already-published posts.
  const allBodyForFlowchart = [
    content.more_content_1, content.more_content_2,
    content.more_content_3, content.more_content_6,
  ].join(" ");
  checks.flowchart_block_exists =
    allBodyForFlowchart.includes('[FLOWCHART_IMG]') ||
    allBodyForFlowchart.includes('aston-flow') ||
    allBodyForFlowchart.includes('aston-timeline') ||
    (content.flowchart_steps?.length ?? 0) > 0;
  if (!checks.flowchart_block_exists)
    warnings.push("Flowchart placeholder missing — add [FLOWCHART_IMG] in the section describing the main process");

  // SEO title length (50–60 chars)
  const titleLen = (content.seo_title ?? "").length;
  checks.seo_title_length_ok = titleLen >= 45 && titleLen <= 65;
  if (!checks.seo_title_length_ok)
    warnings.push(`SEO title is ${titleLen} chars (target 50–60)`);

  // SEO title clarity: no ambiguous / double-meaning terms (e.g. "bank checks").
  // Single-focus is steered by the generation prompt rather than enforced here —
  // a blunt " and " rule would wrongly flag legitimate titles like
  // "...setup costs and banking" or "eligibility, costs and timelines".
  const titleLower = (content.seo_title ?? "").toLowerCase();
  const titleAmbiguous = AMBIGUOUS_TITLE_TERMS.filter((t) => titleLower.includes(t));
  checks.seo_title_focused =
    !!content.seo_title?.trim() && titleAmbiguous.length === 0;
  if (content.seo_title?.trim() && titleAmbiguous.length > 0)
    warnings.push(`SEO title uses an ambiguous term ("${titleAmbiguous.join('", "')}") — use a clearer phrase the reader would search`);

  // Meta description length (110–141 chars)
  const metaLen = (content.meta_description ?? "").length;
  checks.meta_description_length_ok = metaLen >= 110 && metaLen <= 141;
  if (!checks.meta_description_length_ok)
    warnings.push(`Meta description is ${metaLen} chars (target 110–141, ideal 130–141)`);

  // Keypoints and quotes populated
  checks.keypoints_exist =
    !!(content.keypoint_one?.trim()) && !!(content.keypoint_two?.trim());

  checks.quotes_exist =
    !!(content.quote_1?.trim()) && !!(content.quote_2?.trim());
  if (!checks.quotes_exist) warnings.push("One or both quote fields are empty");

  // Minimum 5 external authority links across the article.
  // Count from the HTML directly — the self-reported array can miss links.
  const allBodyHtmlForLinks = [
    content.main_content, content.more_content_1, content.more_content_2,
    content.more_content_3, content.more_content_4, content.more_content_5,
    content.more_content_6,
  ].join(" ");
  const externalHrefMatches = allBodyHtmlForLinks.match(/href="https?:\/\/(?!(?:www\.)?aston\.ae)[^"]+"/gi) ?? [];
  const externalLinkCount = externalHrefMatches.length;
  checks.external_links_present = externalLinkCount >= 5;
  if (!checks.external_links_present)
    warnings.push(`Only ${externalLinkCount} external link(s) found — minimum 5 required`);

  // Banned phrases
  const plainAll = stripHtml(allFields).toLowerCase();
  const foundBanned = BANNED_PHRASES.filter((p) => plainAll.includes(p));
  checks.no_banned_phrases = foundBanned.length === 0;
  if (foundBanned.length > 0)
    warnings.push(`Banned phrase(s) found: ${foundBanned.join(", ")}`);

  // No colons in headings (document requirement)
  const allBodyHtml = [bodyFields, content.more_content_5, content.more_content_6].join(" ");
  checks.no_colons_in_headings = !hasColonInHeadings(allBodyHtml);
  if (!checks.no_colons_in_headings)
    warnings.push("Colon found in one or more headings — headings must use sentence case without colons");

  // No dashes in title (document requirement)
  const articleTitle = title ?? content.seo_title ?? "";
  checks.no_dashes_in_title = !hasDashInTitle(articleTitle);
  if (!checks.no_dashes_in_title)
    warnings.push(`Dash found in article title — titles must be written as one clean natural sentence`);

  // US spelling check
  const plainAllLower = plainAll;
  const foundUS = US_SPELLINGS.filter((w) => plainAllLower.includes(w));
  // House style check: "licence" must always be "license"
  const foundHouseStyle = HOUSE_STYLE_VIOLATIONS.filter((w) => plainAllLower.includes(w));
  checks.no_us_spellings = foundUS.length === 0 && foundHouseStyle.length === 0;
  if (foundUS.length > 0)
    warnings.push(`US spelling(s) found: ${foundUS.join(", ")} — use British English`);
  if (foundHouseStyle.length > 0)
    warnings.push(`House style violation: "${foundHouseStyle.join('", "')}" must be written as "license"`);

  // Key takeaways quality: at least 4 list items, each scannable in a few seconds.
  // The prompt targets 8–14 words per item; flag any item over 18 words (buffer
  // over the target) as too long to scan.
  const takeawayLiTexts = ((content.key_takeaways ?? "").match(/<li[^>]*>([\s\S]*?)<\/li>/gi) ?? [])
    .map((li) => stripHtml(li));
  const takeawayCount = takeawayLiTexts.length;
  const overlongTakeaways = takeawayLiTexts.filter(
    (t) => t.split(/\s+/).filter(Boolean).length > 18
  );
  checks.key_takeaways_quality = takeawayCount >= 4 && overlongTakeaways.length === 0;
  if (takeawayCount < 4)
    warnings.push(`Key takeaways has only ${takeawayCount} items — minimum 4 required`);
  else if (overlongTakeaways.length > 0)
    warnings.push(`${overlongTakeaways.length} key takeaway item(s) exceed 18 words — each must be 8–14 words to scan quickly`);

  // Yoast sentence length: max 25% of sentences may exceed 20 words
  const sentenceLengthPct = longSentencePercent(allFields);
  checks.sentence_length_ok = sentenceLengthPct <= 25;
  if (!checks.sentence_length_ok)
    warnings.push(`${sentenceLengthPct}% of sentences exceed 20 words — Yoast requires ≤25% (target 12–16 words per sentence)`);

  // ── COLLECT BLOCKING ISSUES ───────────────────────────────

  const blockingKeys = [
    "focus_keyword_exists",
    "seo_title_exists",
    "meta_description_exists",
    "slug_exists",
    "excerpt_exists",
    "main_content_exists",
    "key_takeaways_exists",
    "more_content_5_exists",
    "final_points_exists",
    "cta_exists",
    "keypoints_exist",
    // Link presence/count checks are NOT blocking. We actively remove dead
    // (404) links, and removing one must never hold a post for review. These
    // still surface as warnings so low link counts stay visible:
    //   main_content_has_internal_link, main_content_has_external_link,
    //   internal_links_sufficient, external_links_present
    // image checks removed from blocking — images are generated in a
    // separate /api/generate-images request after QA passes
    // "featured_image_exists",
    // "section_images_exist",
    "image_alt_text_exists",
    "focus_keyword_in_title",
  ];

  for (const key of blockingKeys) {
    if (!checks[key]) {
      blocking_issues.push(key.replace(/_/g, " "));
    }
  }

  // ── SCORE ─────────────────────────────────────────────────
  // Each failed check costs points. Blocking failures cost more.
  const totalChecks = Object.keys(checks).length;
  const failedBlocking = blocking_issues.length;
  const failedWarnings = Object.entries(checks)
    .filter(([k, v]) => !v && !blockingKeys.includes(k))
    .length;

  const score = Math.max(
    0,
    Math.round(
      100 - failedBlocking * (60 / totalChecks) - failedWarnings * (40 / totalChecks)
    )
  );

  // ── STATUS ────────────────────────────────────────────────
  const status: "pass" | "warn" | "fail" =
    blocking_issues.length > 0
      ? "fail"
      : warnings.length > 0
      ? "warn"
      : "pass";

  return { status, score, wordCount, checks, warnings, blocking_issues };
}
