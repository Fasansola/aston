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

  const kw = (content.focus_keyword ?? "").toLowerCase();

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

  // Internal links: minimum 7 (document target: 3-10 per 1,000 words)
  checks.internal_links_sufficient =
    (content.internal_links_used?.length ?? 0) >= 7;

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
    ? (content.seo_title ?? "").toLowerCase().includes(kw)
    : false;

  // ── WARNING CHECKS ────────────────────────────────────────
  // Failures here produce warnings but do not block publishing.

  // Total word count — warning only, does not block publishing
  const wordCount = countWords(allFields);
  checks.word_count_in_range = wordCount >= 1800 && wordCount <= 3500;
  if (wordCount < 1800)
    warnings.push(`Word count low: ${wordCount} words (target 2,100–2,800)`);
  else if (wordCount > 3500)
    warnings.push(`Word count high: ${wordCount} words (target 2,100–2,800)`);

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
  const introText = stripHtml(content.main_content ?? "").slice(0, 300).toLowerCase();
  checks.focus_keyword_in_intro = kw ? introText.includes(kw) : false;
  if (!checks.focus_keyword_in_intro && kw)
    warnings.push(`Focus keyword "${content.focus_keyword}" not found in intro`);

  // Focus keyword in at least one section heading
  const headings = extractHeadingText(bodyFields);
  checks.focus_keyword_in_heading = kw
    ? headings.some((h) => h.includes(kw))
    : false;
  if (!checks.focus_keyword_in_heading && kw)
    warnings.push("Focus keyword not found in any section heading");

  // SEO title length (50–60 chars)
  const titleLen = (content.seo_title ?? "").length;
  checks.seo_title_length_ok = titleLen >= 45 && titleLen <= 65;
  if (!checks.seo_title_length_ok)
    warnings.push(`SEO title is ${titleLen} chars (target 50–60)`);

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

  // Key takeaways quality (must have at least 4 list items)
  const takeawayItems = (content.key_takeaways ?? "").match(/<li/gi) ?? [];
  checks.key_takeaways_quality = takeawayItems.length >= 4;
  if (takeawayItems.length < 4)
    warnings.push(`Key takeaways has only ${takeawayItems.length} items — minimum 4 required`);

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
    "main_content_has_internal_link",
    "main_content_has_external_link",
    "key_takeaways_exists",
    "more_content_5_exists",
    "final_points_exists",
    "cta_exists",
    "internal_links_sufficient",
    "keypoints_exist",
    "external_links_present",
    "featured_image_exists",
    "section_images_exist",
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
