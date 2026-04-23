/**
 * lib/readinessValidator.ts
 * ─────────────────────────────────────────────────────────────
 * Search and AI Readiness Validator
 *
 * Produces a composite 0-100 score across 5 weighted categories.
 * Based on Google Search Essentials, Bing Webmaster Guidelines,
 * and Aston VIP editorial rules. Not a ranking guarantee.
 *
 * Weights: Search basics 25 | Content quality 25 |
 *          AI readiness 20  | Bing discoverability 15 |
 *          Editorial compliance 15
 */

// ── Input / Output types ───────────────────────────────────────

export interface ReadinessInput {
  title: string;
  seoTitle: string;
  metaDescription: string;
  slug: string;
  focusKeyword: string;
  articleHtml: string;
  wordCount: number;
  language?: string | null;
  internalLinksCount: number;
  externalLinksCount: number;
  hasLinkValidationFailures?: boolean;
  qaWarnings?: string[];
  qaChecks?: Record<string, boolean>;
}

export interface ReadinessIssue {
  id: string;
  severity: "passed" | "warning" | "failed";
  category: string;
  message: string;
  blocking: boolean;
  suggestedFix?: string;
  actions: Array<"auto_fix" | "manual_fix">;
}

export interface ReadinessSubscore {
  key: string;
  label: string;
  score: number;
  maxScore: number;
  status: "passed" | "warning" | "failed";
  message: string;
  autoFixAvailable: boolean;
  issues: ReadinessIssue[];
}

export interface ReadinessResult {
  overallScore: number;
  overallStatus: "passed" | "warning" | "failed";
  publishState: "ready" | "ready_with_warnings" | "blocked";
  blockingErrors: number;
  warnings: number;
  subscores: ReadinessSubscore[];
  issues: ReadinessIssue[];
}

// ── HTML helpers ───────────────────────────────────────────────

function stripHtml(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function countTag(html: string, tag: string): number {
  return ((html ?? "").match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
}

function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function extractHeadingTexts(html: string): string[] {
  return ((html ?? "").match(/<h[2-5][^>]*>(.*?)<\/h[2-5]>/gi) ?? []).map(
    (h) => stripHtml(h)
  );
}

function hasDashInTitle(title: string): boolean {
  return /\s[—–-]\s/.test(title) || /[—–]/.test(title);
}

function hasColonInHeadings(html: string): boolean {
  return extractHeadingTexts(html).some((h) => h.includes(":"));
}

function isTitleCase(str: string): boolean {
  const words = str.split(" ").filter((w) => w.length > 3);
  if (words.length < 2) return false;
  return words.filter((w) => /^[A-Z]/.test(w)).length > words.length * 0.6;
}

const US_SPELLINGS: Record<string, string> = {
  organization:  "organisation",
  organizations: "organisations",
  optimization:  "optimisation",
  optimizations: "optimisations",
  authorization: "authorisation",
  authorizations: "authorisations",
  centralize:    "centralise",
  centralizes:   "centralises",
  recognize:     "recognise",
  recognizes:    "recognises",
  realize:       "realise",
  realizes:      "realises",
  traveling:     "travelling",
  traveler:      "traveller",
  modeling:      "modelling",
  color:         "colour",
  colors:        "colours",
  behavior:      "behaviour",
  behaviors:     "behaviours",
  neighbor:      "neighbour",
  neighbors:     "neighbours",
  analyze:       "analyse",
  analyzes:      "analyses",
  defense:       "defence",
  offense:       "offence",
  fulfill:       "fulfil",
  fulfills:      "fulfils",
  program:       "programme",
  programs:      "programmes",
};

const BANNED_PHRASES = [
  "seamless", "hassle-free", "empower", "cutting-edge",
  "innovative solution", "game-changing", "leverage", "next-gen",
  "disrupt", "frictionless", "one-stop-shop", "streamline",
  "robust", "comprehensive suite", "tailored solutions",
  "look no further", "unlock", "in conclusion",
  "in today's landscape", "it's worth noting",
];

const WEAK_ANCHORS = ["click here", "here", "read more", "learn more", "this link", "this page"];

function findUsSpellings(plainText: string): string[] {
  const lower = plainText.toLowerCase();
  return Object.keys(US_SPELLINGS).filter((us) => lower.includes(us));
}

function boldWordCount(html: string): number {
  const boldMatches = html.match(/<(?:strong|b)[^>]*>(.*?)<\/(?:strong|b)>/gi) ?? [];
  return boldMatches.reduce((n, m) => n + countWords(stripHtml(m)), 0);
}

function bulletRatio(html: string): number {
  const liCount = countTag(html, "li");
  const pCount  = countTag(html, "p");
  const total   = liCount + pCount;
  return total === 0 ? 0 : liCount / total;
}

function hasWeakAnchorText(html: string): boolean {
  const anchors = html.match(/<a[^>]*>(.*?)<\/a>/gi) ?? [];
  return anchors.some((a) => {
    const text = stripHtml(a).toLowerCase().trim();
    return WEAK_ANCHORS.includes(text);
  });
}

function hasSpammyFormatting(html: string): boolean {
  const plain = stripHtml(html);
  return /[!?]{3,}/.test(plain) || /[A-Z]{8,}/.test(plain);
}

function hasBoldInBodyParagraphs(html: string): boolean {
  const paras = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  return paras.some((p) => /<(?:strong|b)[^>]*>/i.test(p));
}

function hasDecorativeSymbols(html: string): boolean {
  const plain = stripHtml(html);
  return /[→←↑↓★☆✓✗►◄▸▹•◦⟶⟵]/.test(plain);
}

function takeawayItemCount(html: string): number {
  const section = (html.match(/<ul[\s\S]*?<\/ul>/i)?.[0]) ?? html;
  return (section.match(/<li/gi) ?? []).length;
}

// ── Subscores ──────────────────────────────────────────────────

function scoreSearchBasics(input: ReadinessInput): ReadinessSubscore {
  const issues: ReadinessIssue[] = [];
  let earned = 0;
  const MAX = 25;

  // SEO title
  const titleLen = (input.seoTitle ?? "").length;
  if (!input.seoTitle?.trim()) {
    issues.push({ id: "sb_1", severity: "failed", category: "search_basics", message: "SEO title is missing", blocking: true, suggestedFix: "Add an SEO title", actions: ["manual_fix"] });
  } else if (titleLen < 45 || titleLen > 65) {
    issues.push({ id: "sb_1", severity: "warning", category: "search_basics", message: `SEO title is ${titleLen} characters (target 50–60)`, blocking: false, suggestedFix: titleLen > 65 ? "Shorten the SEO title" : "Lengthen the SEO title", actions: ["auto_fix", "manual_fix"] });
  } else {
    earned += 5;
  }

  // Meta description
  const metaLen = (input.metaDescription ?? "").length;
  if (!input.metaDescription?.trim()) {
    issues.push({ id: "sb_2", severity: "failed", category: "search_basics", message: "Meta description is missing", blocking: true, suggestedFix: "Add a meta description (130–165 characters)", actions: ["auto_fix", "manual_fix"] });
  } else if (metaLen < 130 || metaLen > 165) {
    issues.push({ id: "sb_2", severity: "warning", category: "search_basics", message: `Meta description is ${metaLen} characters (target 145–155)`, blocking: false, suggestedFix: metaLen > 165 ? "Shorten the meta description" : "Lengthen the meta description", actions: ["auto_fix", "manual_fix"] });
    earned += 2;
  } else {
    earned += 5;
  }

  // Slug quality
  if (/^[a-z0-9-]+$/.test(input.slug ?? "")) {
    earned += 3;
  } else {
    issues.push({ id: "sb_3", severity: "warning", category: "search_basics", message: "Slug contains invalid characters", blocking: false, suggestedFix: "Use only lowercase letters, numbers, and hyphens", actions: ["auto_fix"] });
  }

  // Heading hierarchy
  const h2 = countTag(input.articleHtml, "h2");
  const h3 = countTag(input.articleHtml, "h3");
  if (h2 + h3 >= 4) {
    earned += 5;
  } else if (h2 + h3 >= 2) {
    earned += 3;
    issues.push({ id: "sb_4", severity: "warning", category: "search_basics", message: `Only ${h2 + h3} H2/H3 headings — target 4+`, blocking: false, suggestedFix: "Add more section headings to structure the article clearly", actions: ["manual_fix"] });
  } else {
    issues.push({ id: "sb_4", severity: "failed", category: "search_basics", message: "Article has fewer than 2 H2/H3 headings", blocking: true, suggestedFix: "Add proper section headings throughout the article", actions: ["manual_fix"] });
  }

  // Word count
  if (input.wordCount >= 1800 && input.wordCount <= 3500) {
    earned += 4;
  } else if (input.wordCount >= 1200) {
    earned += 2;
    issues.push({ id: "sb_5", severity: "warning", category: "search_basics", message: `Word count is ${input.wordCount} (target 1,800–3,500)`, blocking: false, suggestedFix: "Expand the article with more detailed sections", actions: ["manual_fix"] });
  } else {
    issues.push({ id: "sb_5", severity: "failed", category: "search_basics", message: `Article is too short — ${input.wordCount} words (minimum 1,800)`, blocking: true, suggestedFix: "Expand the article significantly before publishing", actions: ["manual_fix"] });
  }

  // Internal links
  if (input.hasLinkValidationFailures) {
    issues.push({ id: "sb_6", severity: "failed", category: "search_basics", message: "Broken internal links detected", blocking: true, suggestedFix: "Fix all broken internal links in the Link Validation panel above", actions: ["manual_fix"] });
  } else if (input.internalLinksCount >= 7) {
    earned += 3;
  } else {
    earned += 1;
    issues.push({ id: "sb_6", severity: "warning", category: "search_basics", message: `Only ${input.internalLinksCount} internal links (target 7+)`, blocking: false, suggestedFix: "Add more internal links to related Aston pages", actions: ["manual_fix"] });
  }

  const status = issues.some((i) => i.severity === "failed") ? "failed" : issues.some((i) => i.severity === "warning") ? "warning" : "passed";
  const pct = Math.round((earned / MAX) * 100);
  return {
    key: "search_basics", label: "Search basics", score: pct, maxScore: 100, status,
    message: status === "passed" ? "Title, meta, headings, and links all look good"
      : status === "warning" ? "Structure is mostly solid but some elements need attention"
      : "Critical SEO elements are missing or broken",
    autoFixAvailable: issues.some((i) => i.actions.includes("auto_fix")),
    issues,
  };
}

function scoreContentQuality(input: ReadinessInput): ReadinessSubscore {
  const issues: ReadinessIssue[] = [];
  let earned = 0;
  const MAX = 25;

  // Not thin
  if (input.wordCount >= 1800) {
    earned += 6;
  } else if (input.wordCount >= 1200) {
    earned += 3;
    issues.push({ id: "cq_1", severity: "warning", category: "content_quality", message: "Article is shorter than recommended — may be seen as thin content", blocking: false, suggestedFix: "Expand with more detailed sections, examples, or explanations", actions: ["manual_fix"] });
  }

  // Real paragraphs
  const pCount = countTag(input.articleHtml, "p");
  if (pCount >= 10) {
    earned += 4;
  } else if (pCount >= 5) {
    earned += 2;
    issues.push({ id: "cq_2", severity: "warning", category: "content_quality", message: `Only ${pCount} paragraphs — article may feel too listy`, blocking: false, suggestedFix: "Convert bullet-heavy sections into flowing paragraphs", actions: ["auto_fix", "manual_fix"] });
  } else {
    issues.push({ id: "cq_2", severity: "failed", category: "content_quality", message: "Article has very few paragraphs — structure needs improving", blocking: false, suggestedFix: "Rewrite sections as flowing prose", actions: ["manual_fix"] });
  }

  // Bullet overuse
  const bRatio = bulletRatio(input.articleHtml);
  if (bRatio <= 0.35) {
    earned += 4;
  } else if (bRatio <= 0.55) {
    earned += 2;
    issues.push({ id: "cq_3", severity: "warning", category: "content_quality", message: `${Math.round(bRatio * 100)}% of content blocks are list items — article leans too heavily on bullets`, blocking: false, suggestedFix: "Convert some bullet lists into explanatory paragraphs", actions: ["manual_fix"] });
  } else {
    issues.push({ id: "cq_3", severity: "warning", category: "content_quality", message: "Article is overly list-heavy — most content engines prefer flowing prose", blocking: false, suggestedFix: "Rewrite bullet-heavy sections as paragraphs", actions: ["manual_fix"] });
  }

  // Bold overuse
  const boldWc  = boldWordCount(input.articleHtml);
  const boldPct = input.wordCount > 0 ? boldWc / input.wordCount : 0;
  if (boldPct <= 0.04) {
    earned += 4;
  } else {
    issues.push({ id: "cq_4", severity: "warning", category: "content_quality", message: `${Math.round(boldPct * 100)}% of words are bold — use bold sparingly in headings only`, blocking: false, suggestedFix: "Remove bold formatting from body paragraph text", actions: ["auto_fix", "manual_fix"] });
    earned += 1;
  }

  // Banned phrases
  const plain = stripHtml(input.articleHtml).toLowerCase();
  const found = BANNED_PHRASES.filter((p) => plain.includes(p));
  if (found.length === 0) {
    earned += 4;
  } else {
    issues.push({ id: "cq_5", severity: "warning", category: "content_quality", message: `Banned phrase${found.length > 1 ? "s" : ""} found: ${found.join(", ")}`, blocking: false, suggestedFix: "Remove or rephrase these overused marketing terms", actions: ["manual_fix"] });
    earned += found.length <= 2 ? 2 : 0;
  }

  // Key takeaways present
  const hasKT = takeawayItemCount(input.articleHtml) >= 4 || (input.qaChecks?.key_takeaways_exists ?? false);
  if (hasKT) {
    earned += 3;
  } else {
    issues.push({ id: "cq_6", severity: "failed", category: "content_quality", message: "Key takeaways block is missing or has fewer than 4 items", blocking: true, suggestedFix: "Add a Key Takeaways section with at least 4 bullet points near the top", actions: ["manual_fix"] });
  }

  const status = issues.some((i) => i.severity === "failed") ? "failed" : issues.some((i) => i.severity === "warning") ? "warning" : "passed";
  const pct = Math.round((earned / MAX) * 100);
  return {
    key: "content_quality", label: "Content quality", score: pct, maxScore: 100, status,
    message: status === "passed" ? "Content is well-structured and people-first"
      : status === "warning" ? "Content is mostly solid but some quality signals need improvement"
      : "Content quality issues detected that may affect rankings",
    autoFixAvailable: issues.some((i) => i.actions.includes("auto_fix")),
    issues,
  };
}

function scoreAiReadiness(input: ReadinessInput): ReadinessSubscore {
  const issues: ReadinessIssue[] = [];
  let earned = 0;
  const MAX = 20;

  // Key takeaways block
  const ktCount = takeawayItemCount(input.articleHtml);
  if (ktCount >= 4) {
    earned += 7;
  } else if (ktCount >= 1) {
    earned += 3;
    issues.push({ id: "ai_1", severity: "warning", category: "ai_readiness", message: "Key takeaways block has fewer than 4 items — AI engines prefer structured summaries", blocking: false, suggestedFix: "Add more bullet points to the Key Takeaways section", actions: ["manual_fix"] });
  } else {
    issues.push({ id: "ai_1", severity: "failed", category: "ai_readiness", message: "Key takeaways block is missing — this is a primary signal for AI answer engines", blocking: true, suggestedFix: "Add a Key Takeaways section near the top of the article", actions: ["manual_fix"] });
  }

  // Heading structure for retrieval
  const headings = extractHeadingTexts(input.articleHtml);
  if (headings.length >= 5) {
    earned += 4;
  } else if (headings.length >= 3) {
    earned += 2;
    issues.push({ id: "ai_2", severity: "warning", category: "ai_readiness", message: "Article has fewer than 5 section headings — AI engines use headings to parse structure", blocking: false, suggestedFix: "Add more descriptive H2/H3 headings throughout the article", actions: ["manual_fix"] });
  } else {
    issues.push({ id: "ai_2", severity: "warning", category: "ai_readiness", message: "Article headings are sparse — AI systems struggle to parse flat content", blocking: false, suggestedFix: "Add clear H2/H3 headings to each major section", actions: ["manual_fix"] });
  }

  // Focus keyword in intro
  const kw = (input.focusKeyword ?? "").toLowerCase();
  const introText = stripHtml(input.articleHtml).slice(0, 400).toLowerCase();
  if (kw && introText.includes(kw)) {
    earned += 4;
  } else if (kw) {
    issues.push({ id: "ai_3", severity: "warning", category: "ai_readiness", message: `Focus keyword "${input.focusKeyword}" not found in the opening paragraphs`, blocking: false, suggestedFix: "Add the focus keyword naturally within the first 300 words", actions: ["manual_fix"] });
    earned += 1;
  }

  // External authority links
  if (input.externalLinksCount >= 1) {
    earned += 3;
  } else {
    issues.push({ id: "ai_4", severity: "warning", category: "ai_readiness", message: "No external authority links — AI engines trust content supported by official sources", blocking: false, suggestedFix: "Add 1–2 links to relevant government, regulator, or institution pages", actions: ["manual_fix"] });
  }

  // Paragraph length (not too long — hard for AI to quote)
  const paras = (input.articleHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) ?? []).map((p) => stripHtml(p));
  const longParas = paras.filter((p) => countWords(p) > 120);
  if (longParas.length === 0) {
    earned += 2;
  } else if (longParas.length <= 2) {
    earned += 1;
    issues.push({ id: "ai_5", severity: "warning", category: "ai_readiness", message: `${longParas.length} paragraph${longParas.length > 1 ? "s are" : " is"} very long (120+ words) — hard for AI engines to extract quotes`, blocking: false, suggestedFix: "Break long paragraphs into shorter, more quotable sections", actions: ["manual_fix"] });
  } else {
    issues.push({ id: "ai_5", severity: "warning", category: "ai_readiness", message: `${longParas.length} paragraphs are very long — AI systems prefer scannable, quotable writing`, blocking: false, suggestedFix: "Shorten paragraphs to 60–100 words for better AI retrieval", actions: ["manual_fix"] });
  }

  const status = issues.some((i) => i.severity === "failed") ? "failed" : issues.some((i) => i.severity === "warning") ? "warning" : "passed";
  const pct = Math.round((earned / MAX) * 100);
  return {
    key: "ai_readiness", label: "AI answer engine readiness", score: pct, maxScore: 100, status,
    message: status === "passed" ? "Article is well-structured for AI engine retrieval and citation"
      : status === "warning" ? "AI readiness is acceptable but could be improved"
      : "Key signals for AI engine pickup are missing",
    autoFixAvailable: false,
    issues,
  };
}

function scoreBingDiscoverability(input: ReadinessInput): ReadinessSubscore {
  const issues: ReadinessIssue[] = [];
  let earned = 0;
  const MAX = 15;

  const kw = (input.focusKeyword ?? "").toLowerCase();

  // Keyword in SEO title
  if (kw && (input.seoTitle ?? "").toLowerCase().includes(kw)) {
    earned += 5;
  } else if (kw) {
    issues.push({ id: "bd_1", severity: "warning", category: "bing_discoverability", message: `Focus keyword "${input.focusKeyword}" is not in the SEO title`, blocking: false, suggestedFix: "Include the focus keyword naturally in the SEO title", actions: ["manual_fix"] });
  }

  // Keyword in at least one heading
  const headings = extractHeadingTexts(input.articleHtml).map((h) => h.toLowerCase());
  if (kw && headings.some((h) => h.includes(kw))) {
    earned += 4;
  } else if (kw) {
    issues.push({ id: "bd_2", severity: "warning", category: "bing_discoverability", message: "Focus keyword does not appear in any section heading", blocking: false, suggestedFix: "Add the focus keyword to at least one H2 or H3 heading", actions: ["manual_fix"] });
    earned += 1;
  }

  // No weak anchor text
  if (!hasWeakAnchorText(input.articleHtml)) {
    earned += 3;
  } else {
    issues.push({ id: "bd_3", severity: "warning", category: "bing_discoverability", message: 'Weak anchor text detected (e.g. "click here", "read more")', blocking: false, suggestedFix: "Replace generic anchor text with descriptive phrases matching the linked page topic", actions: ["auto_fix", "manual_fix"] });
    earned += 1;
  }

  // No spammy formatting
  if (!hasSpammyFormatting(input.articleHtml)) {
    earned += 3;
  } else {
    issues.push({ id: "bd_4", severity: "warning", category: "bing_discoverability", message: "Spammy formatting detected (all-caps text or excessive punctuation)", blocking: false, suggestedFix: "Remove all-caps sections and reduce excessive exclamation marks", actions: ["auto_fix", "manual_fix"] });
  }

  const status = issues.some((i) => i.severity === "failed") ? "failed" : issues.some((i) => i.severity === "warning") ? "warning" : "passed";
  const pct = Math.round((earned / MAX) * 100);
  return {
    key: "bing_discoverability", label: "Bing and general discoverability", score: pct, maxScore: 100, status,
    message: status === "passed" ? "Keyword placement and content signals are strong"
      : status === "warning" ? "Keyword signals could be improved for better discoverability"
      : "Discoverability issues need to be addressed",
    autoFixAvailable: issues.some((i) => i.actions.includes("auto_fix")),
    issues,
  };
}

function scoreEditorialCompliance(input: ReadinessInput): ReadinessSubscore {
  const issues: ReadinessIssue[] = [];
  let earned = 0;
  const MAX = 15;

  const isBritish = !input.language || input.language.toLowerCase().includes("english") || !input.language;

  // British English (only check if language is English/unset)
  if (isBritish) {
    const plain = stripHtml(input.articleHtml).toLowerCase();
    const foundUs = findUsSpellings(plain);
    if (foundUs.length === 0) {
      earned += 5;
    } else {
      const fixes = foundUs.map((us) => `${us} → ${US_SPELLINGS[us]}`).join(", ");
      issues.push({ id: "ec_1", severity: "warning", category: "editorial_compliance", message: `US spelling${foundUs.length > 1 ? "s" : ""} found: ${foundUs.join(", ")}`, blocking: false, suggestedFix: `Convert to British spellings: ${fixes}`, actions: ["auto_fix", "manual_fix"] });
      earned += foundUs.length <= 2 ? 3 : 1;
    }
  } else {
    earned += 5; // Non-English articles skip the British English check
  }

  // Sentence case headings
  const headingTexts = extractHeadingTexts(input.articleHtml);
  const titleCaseHeadings = headingTexts.filter((h) => isTitleCase(h));
  if (titleCaseHeadings.length === 0) {
    earned += 4;
  } else {
    issues.push({ id: "ec_2", severity: "warning", category: "editorial_compliance", message: `${titleCaseHeadings.length} heading${titleCaseHeadings.length > 1 ? "s use" : " uses"} title case — use sentence case only`, blocking: false, suggestedFix: "Convert all headings to sentence case (capitalise first word only)", actions: ["auto_fix", "manual_fix"] });
    earned += 1;
  }

  // No colon in headings
  if (!hasColonInHeadings(input.articleHtml)) {
    earned += 2;
  } else {
    issues.push({ id: "ec_3", severity: "warning", category: "editorial_compliance", message: "Colon found in one or more headings", blocking: false, suggestedFix: "Rewrite headings without colons — use natural phrasing", actions: ["manual_fix"] });
  }

  // No dash in title
  if (!hasDashInTitle(input.title)) {
    earned += 2;
  } else {
    issues.push({ id: "ec_4", severity: "failed", category: "editorial_compliance", message: "Dash found in article title — titles must read as one clean sentence", blocking: true, suggestedFix: "Rewrite the title without dashes or em dashes", actions: ["manual_fix"] });
  }

  // No bold in body paragraphs
  if (!hasBoldInBodyParagraphs(input.articleHtml)) {
    earned += 2;
  } else {
    issues.push({ id: "ec_5", severity: "warning", category: "editorial_compliance", message: "Bold text found inside body paragraphs — bold should only appear in headings", blocking: false, suggestedFix: "Remove bold formatting from paragraph text", actions: ["auto_fix", "manual_fix"] });
  }

  // No decorative symbols
  if (!hasDecorativeSymbols(input.articleHtml)) {
    // No points deducted, this is a clean-pass signal
  } else {
    issues.push({ id: "ec_6", severity: "warning", category: "editorial_compliance", message: "Decorative symbols found (arrows, stars, etc.) — use plain text only", blocking: false, suggestedFix: "Remove →, ★, ✓, and other decorative characters from the text", actions: ["auto_fix", "manual_fix"] });
    earned = Math.max(0, earned - 1);
  }

  const status = issues.some((i) => i.severity === "failed") ? "failed" : issues.some((i) => i.severity === "warning") ? "warning" : "passed";
  const pct = Math.round((earned / MAX) * 100);
  return {
    key: "editorial_compliance", label: "Brand and editorial compliance", score: pct, maxScore: 100, status,
    message: status === "passed" ? "Article follows Aston VIP editorial standards"
      : status === "warning" ? "Most editorial rules are followed but some need attention"
      : "Editorial compliance issues must be fixed before publishing",
    autoFixAvailable: issues.some((i) => i.actions.includes("auto_fix")),
    issues,
  };
}

// ── Main export ────────────────────────────────────────────────

export function runReadinessValidator(input: ReadinessInput): ReadinessResult {
  const sb  = scoreSearchBasics(input);
  const cq  = scoreContentQuality(input);
  const ai  = scoreAiReadiness(input);
  const bd  = scoreBingDiscoverability(input);
  const ec  = scoreEditorialCompliance(input);

  const subscores = [sb, cq, ai, bd, ec];

  // Weighted overall score (weights: 25/25/20/15/15)
  const weights = { search_basics: 0.25, content_quality: 0.25, ai_readiness: 0.20, bing_discoverability: 0.15, editorial_compliance: 0.15 };
  const raw = subscores.reduce((sum, s) => sum + s.score * (weights[s.key as keyof typeof weights] ?? 0), 0);
  const overallScore = Math.round(raw);

  const allIssues = subscores.flatMap((s) => s.issues);
  const blockingErrors = allIssues.filter((i) => i.blocking && i.severity === "failed").length;
  const warnings = allIssues.filter((i) => i.severity === "warning").length;

  // Score threshold + blocking override
  const overallStatus: ReadinessResult["overallStatus"] =
    blockingErrors > 0 ? "failed"
    : overallScore >= 85 ? "passed"
    : overallScore >= 70 ? "warning"
    : "failed";

  const publishState: ReadinessResult["publishState"] =
    blockingErrors > 0 ? "blocked"
    : overallStatus === "passed" ? "ready"
    : "ready_with_warnings";

  return { overallScore, overallStatus, publishState, blockingErrors, warnings, subscores, issues: allIssues };
}

// ── Auto-fix engine ────────────────────────────────────────────

export interface AutoFixResult {
  html: string;
  appliedFixes: string[];
}

export function applyAutoFixes(html: string, language?: string | null): AutoFixResult {
  let fixed = html;
  const appliedFixes: string[] = [];

  // 1. Remove bold from body paragraphs
  const beforeBold = fixed;
  fixed = fixed.replace(/<p([^>]*)>([\s\S]*?)<\/p>/gi, (_, attrs, content) => {
    const cleaned = content.replace(/<\/?(?:strong|b)[^>]*>/gi, "");
    return `<p${attrs}>${cleaned}</p>`;
  });
  if (fixed !== beforeBold) appliedFixes.push("Removed bold formatting from body paragraphs");

  // 2. Convert US spellings to British (English articles only)
  const isBritish = !language || language.toLowerCase().includes("english") || !language;
  if (isBritish) {
    let spellingFixed = false;
    for (const [us, uk] of Object.entries(US_SPELLINGS)) {
      const regex = new RegExp(`\\b${us}\\b`, "gi");
      const next = fixed.replace(regex, (match) => {
        const isCapital = match[0] === match[0].toUpperCase();
        return isCapital ? uk.charAt(0).toUpperCase() + uk.slice(1) : uk;
      });
      if (next !== fixed) { fixed = next; spellingFixed = true; }
    }
    if (spellingFixed) appliedFixes.push("Converted US spellings to British English");
  }

  // 3. Normalise heading case (Title Case → Sentence case)
  fixed = fixed.replace(/(<h[2-5][^>]*>)(.*?)(<\/h[2-5]>)/gi, (_, open, text, close) => {
    const plain = text.replace(/<[^>]+>/g, "");
    const isTc  = isTitleCase(plain);
    if (!isTc) return `${open}${text}${close}`;
    const sentenceCase = plain.charAt(0).toUpperCase() + plain.slice(1).toLowerCase()
      .replace(/\b(difc|adgm|uae|uk|vara|aml|kyc|spv|llc|ltd|plc|gmbh|sa|nv|bv|ag|fca|sec|eu|us)\b/gi,
        (m: string) => m.toUpperCase()
      );
    appliedFixes.push("Converted title-case headings to sentence case");
    return `${open}${sentenceCase}${close}`;
  });

  // 4. Remove decorative symbols
  const symbols = /[→←↑↓★☆✓✗►◄▸▹•◦⟶⟵]/g;
  if (symbols.test(fixed)) {
    fixed = fixed.replace(/[→←↑↓★☆✓✗►◄▸▹◦⟶⟵]/g, "");
    appliedFixes.push("Removed decorative symbols from content");
  }

  return { html: fixed, appliedFixes };
}
