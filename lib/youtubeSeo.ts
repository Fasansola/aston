/**
 * lib/youtubeSeo.ts
 * ─────────────────────────────────────────────────────────────
 * Generates a YouTube-optimised SEO package (title, description, tags) for an
 * Aston VIP video, derived from the blog article's keywords and summary.
 *
 * IMPORTANT: a YouTube title is NOT the same as the blog SEO title. The blog
 * generator deliberately avoids keyword-first, generic, year-stamped titles.
 * YouTube SEO wants the opposite — the main keyword first, the current year,
 * and audience framing. So this produces a SEPARATE title, never the blog one.
 *
 * The description contains a literal {{CHAPTERS}} placeholder. The upload route
 * replaces it with real chapter timings from the rendered video (or removes it
 * if there are no chapters).
 */

import OpenAI from "openai";

export const CHAPTERS_PLACEHOLDER = "{{CHAPTERS}}";
export const CONTACT_URL = "https://aston.ae/contact-us/";

export interface YouTubeSeoInput {
  blogTitle: string;
  focusKeyword: string;
  secondaryKeywords?: string[];
  summary?: string;          // blog meta description / excerpt — gives the model the angle
  blogUrl?: string;          // canonical article URL for the "Read the full guide" line
  language?: string | null;
}

export interface YouTubeSeoPackage {
  title: string;             // keyword-first, <= 100 chars
  description: string;       // contains {{CHAPTERS}} placeholder
  tags: string[];            // 12-15 tags
}

/**
 * Builds the YouTube SEO package via a single gpt-4o call.
 * Falls back to a deterministic template if the model output is unusable, so
 * a video upload never fails purely because SEO generation hiccupped.
 */
export async function generateYouTubeSeoPackage(
  input: YouTubeSeoInput
): Promise<YouTubeSeoPackage> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const year = new Date().getFullYear();

  const isNonEnglish = !!input.language && !["en", "en-gb", "en-us"].includes(input.language.toLowerCase());
  const langNote = isNonEnglish
    ? `Write the title, description and tags entirely in ${input.language}. Do not use English.`
    : "British English spelling (organisation, optimisation). Always write \"license\", never \"licence\".";

  const secondaryLine = input.secondaryKeywords?.length
    ? `Secondary keywords (use as tag and phrasing sources): ${input.secondaryKeywords.slice(0, 16).join(", ")}`
    : "";
  const summaryLine = input.summary?.trim()
    ? `Article summary (the angle to reflect): ${input.summary.trim()}`
    : "";
  const blogUrlLine = input.blogUrl?.trim()
    ? `Canonical article URL (use verbatim in the "Read the full guide" line): ${input.blogUrl.trim()}`
    : `No article URL available — omit the "Read the full guide" line entirely.`;

  const system = `You are a YouTube SEO specialist for Aston VIP, a high-end international corporate advisory firm (company formation, banking, tax structuring, licensing, residency across the UAE, UK, EU and offshore jurisdictions).

You optimise three things: the title, the description, and the tags. Your goal is maximum discoverability in both YouTube search and Google video results, while staying credible and professional — never clickbait.

${langNote}`;

  const user = `Create a YouTube SEO package for a video based on this article.

Blog title: "${input.blogTitle}"
Primary keyword (must lead the title): "${input.focusKeyword}"
${secondaryLine}
${summaryLine}
${blogUrlLine}
Current year: ${year}

Return a single valid JSON object. No markdown, no code fences:

{
  "title": "string",
  "description": "string",
  "tags": ["string", ...]
}

TITLE RULES (all mandatory):
- Start with the primary keyword or a very close natural variant — it must be in the first few words.
- Include the current year (${year}) where it reads naturally.
- Add audience or benefit framing (e.g. "for business owners", "Complete guide", "requirements and costs"). Unlike a blog title, "complete guide" and a colon ARE allowed here.
- 50-70 characters ideal, hard maximum 100. Title case or sentence case both fine.
- Compelling and specific, never clickbait. No emojis in the title.

DESCRIPTION RULES (target 450-900 words total):
Build it in this exact order:
1. Opening: 2-3 sentences. The FIRST sentence must contain the primary keyword — these lines show in search results, so make them count. State plainly what the viewer will learn (requirements, costs, process, etc.).
2. A blank line, then "In this video we explain:" followed by 5 lines, each starting with "✓ " naming a concrete thing the video covers.
3. A blank line, then the literal token ${CHAPTERS_PLACEHOLDER} on its own line. Do not write any chapters yourself — leave this token exactly as-is.
4. A blank line, then 2-3 short paragraphs (about 250-400 words total) expanding the topic with genuinely useful detail — name real regulators, jurisdictions, fee ranges, timelines where relevant. Weave the primary and secondary keywords in naturally; never keyword-stuff.
5. A blank line, then the call-to-action lines:
   - If an article URL was provided: "Read the full guide: <URL>"
   - Always: "Book a consultation: ${CONTACT_URL}"
6. A blank line, then 4-5 hashtags on one line (e.g. "#DubaiGoldenVisa #UAEResidency ..."). Each hashtag is the keyword in PascalCase with no spaces. No more than 5.

TAGS RULES:
- 12-15 tags as an array of plain strings (no "#").
- Include the primary keyword, its close variants (word-order variants), jurisdiction variants, service variants, and the most relevant secondary keywords.
- Real phrases a user would search — no single generic words like "business" or "video".`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.5",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }, { signal: AbortSignal.timeout(45_000) });

    const raw = res.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw) as Partial<YouTubeSeoPackage>;

    const title = (parsed.title ?? "").trim().slice(0, 100) || fallbackTitle(input, year);
    const description = (parsed.description ?? "").trim() || fallbackDescription(input);
    const tags = Array.isArray(parsed.tags) && parsed.tags.length > 0
      ? parsed.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()).slice(0, 15)
      : fallbackTags(input);

    return { title, description, tags };
  } catch (err) {
    console.warn(`[youtubeSeo] Generation failed, using fallback template: ${err instanceof Error ? err.message : String(err)}`);
    return {
      title: fallbackTitle(input, year),
      description: fallbackDescription(input),
      tags: fallbackTags(input),
    };
  }
}

// ── Deterministic fallbacks ───────────────────────────────────
// Never let a single LLM hiccup block a video upload.

function fallbackTitle(input: YouTubeSeoInput, year: number): string {
  const kw = input.focusKeyword.trim();
  const base = `${kw} ${year}: complete guide`;
  return base.length <= 100 ? base : kw.slice(0, 100);
}

function fallbackDescription(input: YouTubeSeoInput): string {
  const kw = input.focusKeyword.trim();
  const lines = [
    `${kw} explained. ${input.summary?.trim() ?? `A practical overview of what ${kw} involves for entrepreneurs and investors.`}`,
    "",
    "In this video we explain:",
    `✓ What ${kw} means`,
    "✓ Who it applies to",
    "✓ Requirements and documents",
    "✓ Costs and timelines",
    "✓ Common mistakes to avoid",
    "",
    CHAPTERS_PLACEHOLDER,
    "",
    ...(input.blogUrl?.trim() ? [`Read the full guide: ${input.blogUrl.trim()}`] : []),
    `Book a consultation: ${CONTACT_URL}`,
  ];
  return lines.join("\n");
}

function fallbackTags(input: YouTubeSeoInput): string[] {
  const set = new Set<string>();
  if (input.focusKeyword.trim()) set.add(input.focusKeyword.trim());
  for (const k of input.secondaryKeywords ?? []) {
    if (k.trim()) set.add(k.trim());
    if (set.size >= 15) break;
  }
  return [...set].slice(0, 15);
}
