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

// ── Main QA function ──────────────────────────────────────────

export function runQA(
  content: BlogContent,
  imagePrompts: ImagePrompts,
  imageIds: {
    keypointOneImg: number;
    keypointTwoImg: number;
    postSplitImg: number;
    featuredImg: number;
  }
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
    content.faq,
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
  checks.main_content_exists = (content.main_content?.length ?? 0) > 80;
  checks.key_takeaways_exists = !!content.key_takeaways?.trim();
  checks.faq_exists = !!content.faq?.trim();
  checks.final_points_exists = !!content.final_points?.trim();

  // CTA: more_content_4 must contain the contact link
  checks.cta_exists =
    (content.more_content_4 ?? "").includes("aston.ae/contact-us/");

  // Internal links: minimum 3
  checks.internal_links_sufficient =
    (content.internal_links_used?.length ?? 0) >= 3;

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

  // Total word count (target 2,100–2,300; allow 1,800–2,800)
  const wordCount = countWords(allFields);
  checks.word_count_in_range = wordCount >= 1800 && wordCount <= 2800;
  if (wordCount < 1800)
    warnings.push(`Word count low: ${wordCount} words (target 2,100–2,300)`);
  else if (wordCount > 2800)
    warnings.push(`Word count high: ${wordCount} words (target 2,100–2,300)`);

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

  // Meta description length (145–155 chars)
  const metaLen = (content.meta_description ?? "").length;
  checks.meta_description_length_ok = metaLen >= 130 && metaLen <= 165;
  if (!checks.meta_description_length_ok)
    warnings.push(`Meta description is ${metaLen} chars (target 145–155)`);

  // Keypoints and quotes populated
  checks.keypoints_exist =
    !!(content.keypoint_one?.trim()) && !!(content.keypoint_two?.trim());
  if (!checks.keypoints_exist) warnings.push("One or both keypoint callouts are empty");

  checks.quotes_exist =
    !!(content.quote_1?.trim()) && !!(content.quote_2?.trim());
  if (!checks.quotes_exist) warnings.push("One or both quote fields are empty");

  // At least one external authority link
  checks.external_links_present =
    (content.external_links_used?.length ?? 0) >= 1;
  if (!checks.external_links_present)
    warnings.push("No external authority links used (recommended)");

  // Banned phrases
  const plainAll = stripHtml(allFields).toLowerCase();
  const foundBanned = BANNED_PHRASES.filter((p) => plainAll.includes(p));
  checks.no_banned_phrases = foundBanned.length === 0;
  if (foundBanned.length > 0)
    warnings.push(`Banned phrase(s) found: ${foundBanned.join(", ")}`);

  // ── COLLECT BLOCKING ISSUES ───────────────────────────────

  const blockingKeys = [
    "focus_keyword_exists",
    "seo_title_exists",
    "meta_description_exists",
    "slug_exists",
    "excerpt_exists",
    "main_content_exists",
    "key_takeaways_exists",
    "faq_exists",
    "final_points_exists",
    "cta_exists",
    "internal_links_sufficient",
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
