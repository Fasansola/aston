/**
 * lib/openai.ts
 * ─────────────────────────────────────────────────────────────
 * All OpenAI interactions.
 *
 * Three-step generation pipeline:
 *  Step 1 — generateBlueprint(): fast structural outline (headings, word
 *            targets, angles, FAQ questions) — no prose written yet
 *  Step 2 — generateBlogContent(): full article written strictly to the
 *            blueprint — consistent layout, correct word counts
 *  Step 3 — generateImagePrompts(): 4 DALL·E prompts derived from the
 *            actual written content, not the title alone
 */

import OpenAI from "openai";
import axios from "axios";
import { BlogContent, Blueprint, ImagePrompts } from "./wordpress";
import { SelectedLinks, formatLinksForPrompt } from "./links";
import { SourceBrief, formatBriefForPrompt } from "./source";
import { StrategyBrief } from "./strategy";

// ── Fixed system prompt — never changes between requests ──────
const SYSTEM_PROMPT = `You are a senior business consultant, SEO strategist, and authoritative blog writer for Aston VIP (Aston.ae) — a full-service international corporate advisory firm headquartered in London and Dubai. Aston VIP advises entrepreneurs, investors, corporate groups, family offices, and fintech businesses on international company formation, regulatory licensing, corporate banking, cross-border tax structuring, and nominee services across 20+ jurisdictions including the UAE (mainland, DIFC, ADGM, free zones), UK, Cyprus, Germany, Switzerland, Spain, Netherlands, Sweden, Denmark, Hong Kong, Panama, Seychelles, and others.

Aston VIP is not a registration agent. They are a proper advisory firm — clients include regulated financial businesses, crypto companies, trading firms, holding groups, and HNWIs who need compliant, bank-ready structures built correctly from the start.

Your writing is authoritative, specific, and human. You write like a practitioner who has guided hundreds of real clients — not like a content farm. Every section must contain concrete details: real jurisdiction names, actual fee ranges, named regulators, realistic timelines, and practical distinctions a reader cannot find in a generic article.

SEO KEYWORD RULES (Yoast green target — every rule below is mandatory):
- Place the exact focus keyword in: the first sentence of the introduction (main_content), the SEO title, the meta description, at least 2 H3 or H4 headings, and at least one key_takeaways item
- Keyphrase density: use the focus keyword naturally approximately once every 100–150 words across the full article (roughly 1–2% density). Spread it evenly — intro, body sections, FAQ — never front-load it
- The slug must contain the exact focus keyword in hyphenated form (e.g. focus keyword "UAE trade licence" → slug begins "uae-trade-licence-...")
- Distribute secondary keywords across more_content_1 through more_content_6 without forcing them
- Never stuff a keyword — if a sentence reads awkwardly, rephrase it or use a natural variation

READABILITY RULES (Yoast readability green target — every rule below is mandatory):
- Transition words: at least one in every three sentences must open with or include a transition (however, therefore, because, this means, as a result, for example, in addition, which means, in practice, by contrast, that said, more importantly, in most cases, as a rule)
- Sentence length: aim for 15–20 words per sentence. Never exceed 25 words in a single sentence. If a sentence is running long, split it in two
- Passive voice: use active voice in at least 9 of every 10 sentences. Write "Aston VIP handles the filing" not "the filing is handled by Aston VIP"
- Paragraph length: maximum 4 sentences per paragraph. Never exceed 100 words in a single paragraph
- Consecutive sentences: never start 3 or more sentences in a row with the same word
- Subheading distribution: place an H3 or H4 at least every 300 words so readers and Yoast never see a wall of text

TONE AND STYLE RULES:
- UK English only: organisation, optimisation, licence (noun), authorised, centre, travelling, adviser
- Sentence case for all headings — do NOT use American title case
- All headings (H3, H4, H5) must be no longer than 8 words or 60 characters. If a heading exceeds this, rephrase it
- Maximum 3-4 lines per paragraph. Each paragraph must start with a clear idea, then explain it properly
- Never use em dashes or en dashes. Use commas or restructure the sentence instead
- Do NOT use colons in any heading, subheading, or section label
- Titles must not contain dashes of any kind — write as one clean natural sentence
- Bold text is allowed only in headings and subheadings — do NOT bold random words inside paragraphs
- Do NOT use arrows, decorative symbols, or unusual punctuation for style
- Write for a reader who is informed but not yet expert. Avoid jargon without context
- Every claim about costs, timelines, or regulations must reflect real, accurate information. Do not invent figures
- The article must read as a continuous professional blog — not a menu, checklist, or collection of bullet points

LINK FORMAT RULES (mandatory):
- Internal links MUST be written as HTML: <a href="/relevant-page-url">anchor text</a>
- External links MUST be written as HTML: <a href="https://official-site.com" target="_blank" rel="nofollow noopener">anchor text</a>
- Only link to real official external sources: regulators, governments, official institutions, authoritative frameworks
- Do NOT invent external URLs. Do NOT cite random blogs or weak sources
- Insert links inside sentences naturally — do NOT group links at the end of sections
- Anchor text must be natural, descriptive, and fit the sentence — never use "click here" or raw URLs
- MINIMUM 4 external links across the full article — spread across different body sections (main_content, more_content_1, more_content_2, more_content_3, more_content_6)

ARTICLE STRUCTURE (mandatory):
1. Title (H1)
2. Key takeaways — directly after the title, before the introduction. This section is NOT optional
3. Introduction
4. Main content sections
5. Conclusion or final advisory section

KEY TAKEAWAYS RULES:
- The key_takeaways field must appear directly after the title in the final article
- It must be clearly formatted as a bullet list
- It must summarise the most important insights of the article
- Each takeaway must contain real decision-useful content — not marketing or vague summaries
- It must contain meaningful, specific, advisory-level points about structure, banking, tax, licensing, regulation, or jurisdiction logic

BANNED PHRASES — never use any of these under any circumstances:
seamless, hassle-free, empower, unlock the power of, cutting-edge, innovative solution, game-changing, leverage, next-gen, disrupt, frictionless, one-stop-shop, solution-oriented, obtain, delve, navigate the complexities, it's worth noting, in today's landscape, in conclusion, unlock, streamline, robust, comprehensive suite, tailored solutions, ever-evolving, look no further`;

// ── Step 1: Generate structure blueprint ──────────────────────

/**
 * Fast first call — produces a structured outline before any prose is written.
 * The blueprint enforces consistent layout, correct word targets per section,
 * and specific headings/angles that the content generator must follow exactly.
 */
const ENGLISH_LANG_CODES = new Set(["en", "en-gb", "en-us"]);

function isNonEnglish(language?: string): boolean {
  return !!language && !ENGLISH_LANG_CODES.has(language.toLowerCase());
}

export async function generateBlueprint(
  title: string,
  selectedLinks: SelectedLinks,
  sourceBrief?: SourceBrief,
  strategy?: StrategyBrief | null,
  customPrompt?: string,
  language?: string
): Promise<Blueprint> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const linkCategories = [
    ...selectedLinks.internal.map((l) => l.title),
    ...selectedLinks.external.map((l) => l.title),
  ].join(", ");

  const sourceBriefBlock = sourceBrief ? formatBriefForPrompt(sourceBrief) : "";

  const strategyBlock = strategy ? `
STRATEGY BRIEF (use as source of truth for this blueprint):
- Primary keyword: ${strategy.keyword_model.primary_keyword}
- Primary keyword rationale: ${strategy.keyword_model.primary_keyword_why}
- Secondary keywords: ${strategy.keyword_model.secondary_keywords.slice(0, 10).join(", ")}
- Article angle: ${strategy.article_angle}
- Search intent: ${strategy.search_intent_type} — ${strategy.search_intent.slice(0, 200)}
- Commercial service layers: ${strategy.commercial_intent_layers.slice(0, 4).join("; ")}
- High-value strategy: ${strategy.high_value_strategy.slice(0, 300)}
- Content risks to avoid: ${strategy.content_risks.slice(0, 5).join("; ")}
` : "";

  const customPromptBlock = customPrompt?.trim()
    ? `\nCUSTOM INSTRUCTIONS (highest priority — follow throughout the blueprint):\n${customPrompt.trim()}\n`
    : "";

  const languageBlock = isNonEnglish(language)
    ? `\nTARGET LANGUAGE: ${language!.toUpperCase()} — MANDATORY OVERRIDE\nEvery field in this blueprint — seo_title, meta_description, focus_keyword, secondary_keywords, intro_angle, all h3_heading and h4_heading values, all angle descriptions, all faq_questions — MUST be written entirely in ${language}. No English words or phrases anywhere. The "UK English only" rule in the system prompt does NOT apply here. Write everything in ${language}.\n`
    : "";

  const userPrompt = `Blog title: "${title}"
Available link topics for context: ${linkCategories}
${languageBlock}${strategyBlock}${customPromptBlock}${sourceBriefBlock ? `\n${sourceBriefBlock}\n` : ""}

Plan the structure of this blog post and return it as a single valid JSON object. No markdown, no code fences:

{
  "focus_keyword": "string",
  "secondary_keywords": ["string", "string", "string", "string"],
  "seo_title": "string",
  "meta_description": "string",
  "slug": "string",
  "estimated_word_count": 2200,
  "intro_angle": "string",
  "sections": [
    {
      "field": "more_content_1",
      "h3_heading": "string",
      "angle": "string",
      "target_words": 380,
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_2",
      "h3_heading": "string",
      "angle": "string",
      "target_words": 380,
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_3",
      "h3_heading": "string",
      "angle": "string",
      "target_words": 380,
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_4",
      "h3_heading": "Aston VIP's role in your [adapt to topic]",
      "angle": "string",
      "target_words": 380,
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_6",
      "h3_heading": "string",
      "angle": "string",
      "target_words": 320,
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    }
  ],
  "faq_questions": ["string", "string", "string", "string"]
}

BLUEPRINT RULES:
- focus_keyword: ${strategy ? `use exactly "${strategy.keyword_model.primary_keyword}" — this has been determined by the strategy engine` : "the single phrase this article should rank for in Google — 2 to 4 words, as a reader would actually type it into Google"}

- seo_title: STRICT RULES — all must be met simultaneously:
  1. Begin with the exact focus keyword as the first words (e.g. "UAE trade licence: complete guide" starts with "UAE trade licence")
  2. Exactly 50–60 characters including spaces — count precisely before returning
  3. After the focus keyword, add a power phrase that earns the click: "complete guide", "requirements and costs", "step-by-step guide", "what you need to know", "how it works", "explained" — pick the one that best matches search intent
  4. Sentence case only — capitalise only the first word and proper nouns
  5. No site name, no pipes, no dashes, no question marks
  6. The title must read as one natural, direct phrase — not a list, not a sentence with a verb

- meta_description: This appears verbatim on Google — it must be complete, punchy, and entice the reader to click. STRICT RULES — all must be met simultaneously:
  1. HARD MAXIMUM: 141 characters including spaces. This is an absolute ceiling — never exceed it under any circumstance. Count the characters in your final string before returning it. If your draft is 142 or more characters, rewrite the sentence with shorter words or remove a clause — do NOT truncate mid-word or mid-thought.
  2. TARGET: aim for 138–141 characters. If you genuinely cannot reach 138 without padding or filler, 130–137 is acceptable — but never go below 130.
  3. The description must be a COMPLETE, grammatically correct sentence or two that ends on a full stop or clear CTA. It must never trail off or end mid-thought.
  4. Place the exact focus keyword within the first 60 characters
  5. Lead with the specific outcome or insight the reader gets — name a real number, jurisdiction, timeline, or comparison; no vague claims
  6. End with a punchy, direct CTA that creates urgency or curiosity: "Aston VIP walks you through every step.", "Find out exactly what applies to your situation.", "Speak to our advisers before you commit." — vary it; do not repeat the same CTA across articles
  7. Active voice, present tense — write as if talking to the reader directly
  8. Must not repeat the seo_title verbatim — complement it, do not duplicate it
  9. Never use: seamless, hassle-free, comprehensive, robust, tailored, one-stop, navigate, landscape, unlock, dive

- slug: lowercase hyphenated only — STRICT RULES:
  1. Start with the exact focus keyword hyphenated (e.g. "UAE trade licence" → starts with "uae-trade-licence")
  2. Strip ALL stop words after the keyword (the, a, an, of, for, with, to, in, on, at, by, and, or, your, our)
  3. Total length: 3–5 words maximum — shorter is better for Google
  4. Only add 1 extra word after the focus keyword if it meaningfully disambiguates (e.g. "-guide", "-requirements", "-2025") — otherwise stop at the keyword itself
  5. No numbers, no years, unless they are part of the focus keyword itself
- intro_angle: one sentence describing what the intro should establish — the business problem or opportunity
- sections[].h3_heading: the exact H3 heading for that section, sentence case, max 8 words
- sections[].angle: one sentence describing what that section covers and what the reader should understand after reading it
- sections[].subsections[].h4_heading: the exact H4 heading, sentence case, max 8 words
- sections[].subsections[].angle: one sentence describing the subsection focus
- more_content_4 must always open with an Aston VIP CTA heading adapted to the topic
- more_content_6 must be a distinct fifth body section covering a practical angle not addressed in sections 1–4 (e.g. common mistakes, jurisdiction comparison, a specific use case, or a compliance checklist). Do not duplicate more_content_4 themes.
- faq_questions: 4 specific questions a real reader would ask about this topic. Questions only, no answers yet`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    max_completion_tokens: 2000,
  }, { signal: AbortSignal.timeout(60_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Blueprint response was cut off by the token limit. Increase max_tokens or shorten the prompt.");
  }

  const raw = choice.message.content?.trim() ?? "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `No JSON found in blueprint response. Raw: ${raw.slice(0, 200)}`
    );
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Blueprint;
    if (parsed.meta_description && parsed.meta_description.length > 141) {
      const cut = parsed.meta_description.slice(0, 141);
      const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
      parsed.meta_description = lastStop > 80 ? parsed.meta_description.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "");
    }
    return parsed;
  } catch {
    throw new Error(
      `Blueprint returned invalid JSON. Raw: ${raw.slice(0, 200)}`
    );
  }
}

// ── Step 2: Generate blog content from blueprint ──────────────

/**
 * Write the full article using the blueprint as the source of truth.
 * Every section heading, angle, and word target comes from the blueprint —
 * the AI fills in the prose, not the structure.
 */
export async function generateBlogContent(
  title: string,
  blueprint: Blueprint,
  selectedLinks: SelectedLinks,
  sourceBrief?: SourceBrief,
  strategy?: StrategyBrief | null,
  customPrompt?: string,
  language?: string
): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const linksBlock = formatLinksForPrompt(selectedLinks, language);
  const sourceBriefBlock = sourceBrief ? formatBriefForPrompt(sourceBrief) : "";

  const strategyContentBlock = strategy ? `
STRATEGY CONTEXT (use throughout the article):
Article angle: ${strategy.article_angle}
Banking angle: ${strategy.banking_tax_structuring_compliance.banking.slice(0, 200)}
Tax angle: ${strategy.banking_tax_structuring_compliance.tax.slice(0, 200)}
Structuring angle: ${strategy.banking_tax_structuring_compliance.structuring.slice(0, 200)}
High-value strategy: ${strategy.high_value_strategy.slice(0, 300)}
Internal link plan: ${strategy.internal_link_plan.slice(0, 300)}
External link plan: ${strategy.external_link_plan.slice(0, 300)}
Content risks to avoid: ${strategy.content_risks.join("; ")}

PRE-PLANNED KEY TAKEAWAYS (use these as the basis for the key_takeaways field — refine and format as HTML list):
${strategy.key_takeaways.map((t, i) => `${i + 1}. ${t}`).join("\n")}
` : "";

  // Serialise blueprint sections into clear per-field instructions
  const sectionInstructions = blueprint.sections
    .map((s) => {
      const subs = s.subsections
        .map((sub) => `    H4: "${sub.h4_heading}" — ${sub.angle}`)
        .join("\n");
      return `${s.field} (target: ~${s.target_words} words)
  H3: "${s.h3_heading}"
  Angle: ${s.angle}
${subs}`;
    })
    .join("\n\n");

  const faqInstructions = blueprint.faq_questions
    .map((q, i) => `  Q${i + 1}: ${q}`)
    .join("\n");

  const customPromptContentBlock = customPrompt?.trim()
    ? `\nCUSTOM INSTRUCTIONS (highest priority — follow throughout the entire article):\n${customPrompt.trim()}\n`
    : "";

  const languageContentBlock = isNonEnglish(language)
    ? `\nTARGET LANGUAGE: ${language!.toUpperCase()} — MANDATORY OVERRIDE\nThe ENTIRE article — every paragraph, every heading, every key takeaway, the excerpt, all quotes, and all SEO fields (seo_title, meta_description, focus_keyword) — MUST be written entirely in ${language}. No English words or phrases anywhere. The "UK English only" rule in the system prompt does NOT apply. Write everything in ${language}.\n`
    : "";

  const userPrompt = `Blog title: "${title}"
${languageContentBlock}${strategyContentBlock}${customPromptContentBlock}${sourceBriefBlock ? `\n${sourceBriefBlock}\n` : ""}
You have already planned the structure. Now write the full article following the blueprint exactly.
The headings, section angles, and word targets below are fixed — do not change them.

BLUEPRINT:
Focus keyword: ${blueprint.focus_keyword}
Secondary keywords: ${blueprint.secondary_keywords.join(", ")}
Intro angle: ${blueprint.intro_angle}

SECTION STRUCTURE (follow exactly):
${sectionInstructions}

FAQ QUESTIONS (write a concise, factual answer for each):
${faqInstructions}

Return as a single valid JSON object with exactly these fields. No markdown, no code fences:

{
  "focus_keyword": "${blueprint.focus_keyword}",
  "secondary_keywords": ${JSON.stringify(blueprint.secondary_keywords)},
  "seo_title": "${blueprint.seo_title}",
  "meta_description": "${blueprint.meta_description}",
  "slug": "${blueprint.slug}",
  "excerpt": "string",
  "main_content": "string",
  "keypoint_one": "string",
  "more_content_1": "string",
  "more_content_2": "string",
  "quote_1": "string",
  "more_content_3": "string",
  "keypoint_two": "string",
  "more_content_4": "string",
  "quote_2": "string",
  "key_takeaways": "string",
  "more_content_5": "string",
  "more_content_6": "string",
  "final_points": "string",
  "read_mins": "string",
  "internal_links_used": [{"anchor": "string", "url": "string"}],
  "external_links_used": [{"anchor": "string", "url": "string"}]
}

FIELD INSTRUCTIONS:

excerpt:
2-3 sentence plain-text excerpt for WordPress archive pages. No HTML. 40-60 words.

main_content (300-340 words — MINIMUM 300, count before submitting):
- Open with the business problem or opportunity described in the intro angle: "${blueprint.intro_angle}"
- The focus keyword must appear in the first sentence of the first paragraph — not the second, not the third
- Use the focus keyword 2–3 times naturally across the full intro (spread across different paragraphs)
- Do NOT open with an H3. Start with a <p> tag
- After the opening paragraph, you MUST include at least 2 H3 subheadings to break the text into scannable sections — do not write 300 words of unbroken paragraphs
- Heading hierarchy: every H4 must sit under an H3. Never skip levels
- End with a sentence that pulls the reader into what follows
- LINKS (mandatory): embed exactly 1 internal link and at least 1 external link naturally within the text — both must sit inside a sentence and support the point being made
- SENTENCE LENGTH (mandatory): no sentence may exceed 20 words. If a sentence is running long, split it into two. This applies to every paragraph in this section
- Allowed HTML: <h3>, <h4>, <p>, <strong>, <em>, <a>

keypoint_one:
A single compelling sentence (max 25 words) from the key insight of main_content. Plain text only — no markdown, no asterisks, no bold tags. No em dashes. No question marks.

more_content_1:
- Use EXACTLY this H3: "${blueprint.sections[0]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[0]?.angle ?? ""}
- Write each H4 subsection as specified in the blueprint
- Target ~${blueprint.sections[0]?.target_words ?? 380} words
- Must include at least one: specific cost/fee in AED or USD, named regulatory body, realistic timeline, or jurisdiction comparison
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

more_content_2:
- Use EXACTLY this H3: "${blueprint.sections[1]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[1]?.angle ?? ""}
- Write each H4 subsection as specified in the blueprint
- Target ~${blueprint.sections[1]?.target_words ?? 380} words
- Must include a bulleted or numbered list of at least 4 concrete items with facts, figures, or named details
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

quote_1:
Short, punchy, practical advice from more_content_1 or more_content_2. Max 2 sentences. No em dashes. Actionable.

more_content_3:
- Use EXACTLY this H3: "${blueprint.sections[2]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[2]?.angle ?? ""}
- Write each H4 subsection as specified in the blueprint
- Target ~${blueprint.sections[2]?.target_words ?? 380} words
- Cover ideal client profiles. Include at least one real-world scenario as a short narrative
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

keypoint_two:
A single compelling sentence (max 25 words) from the key insight of more_content_3. Plain text only — no markdown, no asterisks, no bold tags. No em dashes. No question marks. Different from keypoint_one.

more_content_4:
- Use EXACTLY this H3: "${blueprint.sections[3]?.h3_heading ?? "Aston VIP's role in your process"}"
- Follow the angle: ${blueprint.sections[3]?.angle ?? ""}
- Write each H4 subsection as specified in the blueprint
- Target ~${blueprint.sections[3]?.target_words ?? 380} words
- Describe Aston's end-to-end involvement specific to this topic. Do not describe Aston generically
- Close with: <p>To discuss your situation, <a href="https://aston.ae/contact-us/">speak with our team</a>.</p>
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <strong>, <a>

quote_2:
Short, punchy advice from more_content_4. Max 2 sentences. No em dashes. Different from quote_1.

key_takeaways:
HTML <ul><li> list of 4 to 6 items. This section appears directly after the title — before the introduction. ${strategy ? "Use and refine the PRE-PLANNED KEY TAKEAWAYS provided above — adapt them to match the final article content. Each must be a standalone advisory point with real decision-useful insight about structure, banking, tax, licensing, regulation, or jurisdiction logic. Not marketing. Not vague summaries." : "Each must contain at least one named figure, regulator, jurisdiction, timeline, or cost. Include the focus keyword in at least one item."}
LENGTH RULE: each list item must be 8–14 words maximum — short enough to scan in under 3 seconds. Cut any item that runs longer. Lead with the specific fact or number, not a preamble. Example format: "DIFC company formation costs from AED 15,000 in fees." or "UAE corporate tax is 9% on profits above AED 375,000."
Allowed HTML: <ul>, <li> only. Do NOT use <strong> or any other tags inside list items — plain text only.

more_content_5:
Write answers for each of these FAQ questions using the format below.
Questions: ${blueprint.faq_questions.map((q, i) => `Q${i + 1}: ${q}`).join(" | ")}
Format each as: <h3>Question text</h3><p>Answer (2-4 sentences, factual, specific)</p>
Do NOT wrap in any container — just the h3/p pairs.
Allowed HTML: <h3>, <p>, <strong>

more_content_6:
- Use EXACTLY this H3: "${blueprint.sections[4]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[4]?.angle ?? ""}
- Write each H4 subsection as specified in the blueprint
- Target ~${blueprint.sections[4]?.target_words ?? 320} words
- This is a distinct fifth body section — do not repeat themes from more_content_4
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

final_points:
HTML <ul><li> list of exactly 4 practical next steps. Start each with a verb. Specific and actionable.
Allowed HTML: <ul>, <li>, <strong>

read_mins:
Number string only. Estimate at 200 words per minute. Example: "9"

internal_links_used:
Array of objects recording every internal link placed in the article body.

external_links_used:
Array of objects recording every external link placed. Empty array if none used.

${linksBlock}`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.6,
    max_completion_tokens: 32000,
  }, { signal: AbortSignal.timeout(180_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Content response was cut off by the token limit — the JSON is incomplete. Reduce content scope or increase max_tokens.");
  }

  const raw = choice.message.content?.trim() ?? "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in GPT response. Raw: ${raw.slice(0, 200)}`);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as BlogContent;
    if (parsed.meta_description && parsed.meta_description.length > 141) {
      const cut = parsed.meta_description.slice(0, 141);
      const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
      parsed.meta_description = lastStop > 80 ? parsed.meta_description.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "");
    }
    return parsed;
  } catch {
    throw new Error(`GPT returned invalid JSON. Raw: ${raw.slice(0, 200)}`);
  }
}

// ── Step 3: Generate content-aware image prompts ──────────────

/**
 * Write 4 DALL·E prompts from the actual written content.
 * Called after generateBlogContent() so each prompt references the real
 * section topic, not just the article title.
 */
export async function generateImagePrompts(
  title: string,
  content: BlogContent
): Promise<ImagePrompts> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const strip = (html: string, len = 400) =>
    html.slice(0, len).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const keywords = [content.focus_keyword, ...(content.secondary_keywords ?? [])].join(", ");

  const userPrompt = `You are creating 4 distinct, topic-specific image prompts for a blog post.

ARTICLE TITLE: "${title}"
FOCUS KEYWORD: "${content.focus_keyword}"
KEY TOPICS: ${keywords}

SECTION CONTENT (use these to determine what each image should show):

IMAGE 1 — keypoint_one (illustrates the article introduction):
"${strip(content.main_content)}"

IMAGE 2 — keypoint_two (illustrates the mid-article insight):
"${strip(content.more_content_3)}"

IMAGE 3 — post_split (illustrates the Aston VIP advisory/process section):
"${strip(content.more_content_4)}"

IMAGE 4 — featured hero (represents the full article topic — this must be the most specific and striking image, directly visualising "${content.focus_keyword}")

TOPIC-TO-SCENE GUIDE — use this to pick the right setting for each image:
- DIFC / DFSA → DIFC Gate building exterior, glass towers, financial district walkway
- ADGM / Abu Dhabi → Al Maryah Island skyline, ADGM square glass towers, waterfront
- VARA / crypto / virtual assets → clean minimalist tech office, abstract digital network nodes, server room with cool blue lighting — NO coins or currency symbols
- UAE mainland / trade licence → modern Dubai business district, government service centre, document signing
- Tax / corporate tax / VAT → financial documents spread on a desk, calculator, structured corporate paperwork
- Banking / EMI / payment licence → modern private bank interior, vault corridor, payment terminal close-up
- Company formation / incorporation → corporate seal, certificate of incorporation on a desk, handshake in a modern lobby
- Offshore / Seychelles / BVI → tropical island aerial with clean blue water, corporate office contrast with island backdrop
- Cyprus / EU jurisdiction → Limassol or Nicosia modern skyline, Mediterranean light, EU-style corporate building
- Germany / Frankfurt / EU → Frankfurt banking district skyline, Commerzbank Tower area, glass and steel architecture
- Holding company / structuring → layered corporate org chart visualised as glass building floors, abstract structure
- Startups / founders → bright co-working space, whiteboard, young professionals collaborating
- Golden Visa / residency → luxury Dubai apartment view, residence document, passport on a desk
- General / mixed → neutral modern international office, floor-to-ceiling windows, city view below

RULES FOR EVERY PROMPT:
- Each image must visualise a DIFFERENT aspect of the topic — no two prompts should describe the same scene
- Featured image must show the most striking, instantly recognisable visual for "${content.focus_keyword}"
- Apply Aston VIP visual style: high-end corporate editorial photography, bright and airy interiors, natural daylight through floor-to-ceiling windows or soft warm studio lighting, neutral whites/warm greys/muted golds, never oversaturated — think Architectural Digest meets Bloomberg editorial
- Let the architectural setting or object carry the topic — do not add people unless the scene requires a human interaction (e.g. document signing, consultation). When people are included they must be dressed in formal business attire and shown from behind or side-on — no faces
- Never include: text of any kind, logos, watermarks, flags, digital screens with readable content, clocks, coins, currency symbols, phone or laptop screens
- End every prompt with: "shot on Canon EOS R5, 85mm f/1.4 lens, shallow depth of field, soft natural light or warm studio lighting, ultra-sharp focus on subject, professional corporate editorial photography, cinematic warm-neutral colour grade, no text overlay, no logos, no watermarks"
- 2–3 sentences per prompt. Structure each prompt as: (1) the specific scene and subject in detail, (2) lighting quality, atmosphere, and mood, (3) the camera and style suffix above

Return as a single valid JSON object. No markdown, no code fences:

{
  "keypoint_one_img_prompt": "string",
  "keypoint_one_img_alt": "string",
  "keypoint_two_img_prompt": "string",
  "keypoint_two_img_alt": "string",
  "post_split_img_prompt": "string",
  "post_split_img_alt": "string",
  "featured_img_prompt": "string",
  "featured_img_alt": "string"
}

Alt text rules (SEO-optimised — all must be met):
1. Describe exactly what is visually shown — specific scene, setting, and subject (e.g. "DIFC Gate building entrance with suited adviser walking through glass doors" not "business meeting")
2. Include the focus keyword "${content.focus_keyword}" naturally in at least 2 of the 4 alt texts
3. Featured image alt text must always include the focus keyword
4. 8–12 words per alt text — descriptive but not stuffed
5. No full stops, no quotes, no HTML
6. Never start with "image of" or "photo of" — start directly with the subject`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.5,
    max_completion_tokens: 2000,
  }, { signal: AbortSignal.timeout(60_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Image prompts response was cut off by the token limit.");
  }

  const raw = choice.message.content?.trim() ?? "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `No JSON found in image prompts response. Raw: ${raw.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(jsonMatch[0]) as ImagePrompts;
  } catch {
    throw new Error(
      `GPT returned invalid JSON for image prompts. Raw: ${raw.slice(0, 200)}`
    );
  }
}

// ── Step 2b: Fix only the fields that failed QA ───────────────

// QA checks that relate to images — if only these fail, content doesn't need fixing
export const IMAGE_QA_CHECKS = ["featured_image_exists", "section_images_exist", "image_alt_text_exists"];

// Maps each QA check key → the BlogContent field(s) responsible
const CHECK_TO_FIELDS: Record<string, string[]> = {
  // Blocking — structural metadata
  focus_keyword_exists:             ["focus_keyword"],
  seo_title_exists:                 ["seo_title"],
  meta_description_exists:          ["meta_description"],
  slug_exists:                      ["slug"],
  excerpt_exists:                   ["excerpt"],
  // Blocking — content body
  main_content_exists:              ["main_content"],
  main_content_has_internal_link:   ["main_content"],
  main_content_has_external_link:   ["main_content"],
  key_takeaways_exists:             ["key_takeaways"],
  more_content_5_exists:            ["more_content_5"],
  final_points_exists:              ["final_points"],
  cta_exists:                       ["more_content_4"],
  internal_links_sufficient:        ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_6"],
  focus_keyword_in_title:           ["seo_title"],
  // Non-blocking — keyword/SEO
  focus_keyword_in_intro:           ["main_content"],
  focus_keyword_in_heading:         ["main_content", "more_content_1"],
  seo_title_length_ok:              ["seo_title"],
  meta_description_length_ok:       ["meta_description"],
  no_dashes_in_title:               ["seo_title"],
  // Non-blocking — structure
  word_count_in_range:              ["main_content", "more_content_1", "more_content_2", "more_content_3"],
  h3_count_sufficient:              ["main_content", "more_content_1", "more_content_2", "more_content_3"],
  h4_count_sufficient:              ["more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5"],
  keypoints_exist:                  ["keypoint_one", "keypoint_two"],
  quotes_exist:                     ["quote_1", "quote_2"],
  external_links_present:           ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_6"],
  no_banned_phrases:                ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"],
  no_colons_in_headings:            ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"],
};

const CHECK_DESCRIPTIONS: Record<string, string> = {
  // Structural metadata
  focus_keyword_exists:             "focus_keyword is empty — write a short, specific keyword phrase (3–5 words) that this article targets",
  seo_title_exists:                 "seo_title is empty — write an SEO-optimised title (45–65 chars) containing the focus keyword",
  meta_description_exists:          "meta_description is empty — write it (130–141 chars, contain focus keyword, end with a call to action)",
  slug_exists:                      "slug is empty or invalid — write a lowercase hyphenated URL slug (only a-z, 0-9, hyphens; no spaces)",
  excerpt_exists:                   "excerpt is empty — write a 1–2 sentence plain-text summary of the article (no HTML)",
  // Content body
  main_content_exists:              "main_content is under 270 words — rewrite it to at least 300 words",
  main_content_has_internal_link:   "main_content has no internal link — embed exactly 1 internal link from the provided list",
  main_content_has_external_link:   "main_content has no external link — embed at least 1 external link from an official source (regulator, government, institution)",
  key_takeaways_exists:             "key_takeaways is empty — write 4–6 bullet points",
  more_content_5_exists:            "more_content_5 (FAQ) is empty — write answers to the FAQ questions from the blueprint",
  final_points_exists:              "final_points is empty — write exactly 4 practical next steps",
  cta_exists:                       `more_content_4 is missing the contact CTA — end it with: <p>To discuss your situation, <a href="https://aston.ae/contact-us/">speak with our team</a>.</p>`,
  internal_links_sufficient:        "fewer than 7 internal links across the article — add more internal links from the provided list, spread across the listed sections",
  focus_keyword_in_title:           "focus keyword not present in seo_title — rewrite the title to include it naturally",
  // SEO/keyword
  focus_keyword_in_intro:           "focus keyword missing from the first paragraph of main_content — include it in the first sentence",
  focus_keyword_in_heading:         "focus keyword not found in any H2/H3 heading — naturally include it in at least one heading",
  seo_title_length_ok:              "seo_title is outside 45–65 characters — rewrite to fit within this range while keeping the focus keyword",
  meta_description_length_ok:       "meta_description is outside 130–141 characters — rewrite to land in this exact range",
  no_dashes_in_title:               "seo_title contains a dash — rewrite the title without using dashes",
  // Structure
  word_count_in_range:              "total article word count is outside 1800–3500 words — expand thin sections or trim bloated ones",
  h3_count_sufficient:              "fewer than 4 H3 subheadings in the article — add subheadings to break up long sections",
  h4_count_sufficient:              "fewer than 6 H4 subheadings in the article — add H4 sub-points under existing H3 sections",
  keypoints_exist:                  "one or both keypoint callout boxes are empty — write them",
  quotes_exist:                     "one or both pull-quote fields are empty — write a compelling 1–2 sentence quote for each",
  external_links_present:           "fewer than 4 external links in the article — add authoritative external links (regulators, governments, official institutions) spread across main_content, more_content_1, more_content_2, more_content_3, and more_content_6 until the total reaches at least 4",
  no_banned_phrases:                "banned phrase(s) found in the article — identify and remove or replace them",
  no_colons_in_headings:            "colon found in one or more headings — rewrite those headings without colons",
};

/**
 * Fix only the content fields that failed QA, leaving everything else intact.
 * Called on QA retry attempts 2 and 3 instead of a full regeneration.
 */
export async function fixBlogContent(
  title: string,
  previousContent: BlogContent,
  blueprint: Blueprint,
  selectedLinks: SelectedLinks,
  failingChecks: Record<string, boolean>,
  language?: string,
  brokenUrls?: string[]
): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const failedKeys = Object.entries(failingChecks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key)
    .filter((key) => !IMAGE_QA_CHECKS.includes(key));

  const fieldsToFix = [...new Set(failedKeys.flatMap((k) => CHECK_TO_FIELDS[k] ?? []))];

  // If no mapping found (unknown check key), there's nothing targeted to fix — skip silently
  // rather than returning unchanged content, log and proceed with whatever fields we do have.
  if (fieldsToFix.length === 0) {
    console.warn(`[fixBlogContent] No field mappings found for failing checks: ${failedKeys.join(", ")} — skipping content fix`);
    return previousContent;
  }

  const linksBlock = formatLinksForPrompt(selectedLinks, language);

  const issueList = failedKeys
    .map((k, i) => `${i + 1}. ${CHECK_DESCRIPTIONS[k] ?? `"${k}" check failed`}`)
    .join("\n");

  const currentFieldsBlock = fieldsToFix
    .map((f) => {
      const val = (previousContent as unknown as Record<string, unknown>)[f] as string ?? "";
      return `--- ${f} (current — needs fixing) ---\n${val || "(empty)"}`;
    })
    .join("\n\n");

  const alreadyUsed = (previousContent.internal_links_used ?? [])
    .map((l) => `- ${l.url} (anchor: "${l.anchor}")`)
    .join("\n") || "None";

  const prompt = `You are fixing specific QA failures in a blog article for Aston VIP. Fix ONLY the fields listed below and return them as JSON.

ARTICLE CONTEXT:
Title: "${title}"
Focus keyword: "${blueprint.focus_keyword}"
Secondary keywords: ${blueprint.secondary_keywords.join(", ")}

ISSUES TO FIX:
${issueList}

CURRENT CONTENT OF FIELDS THAT NEED FIXING:
${currentFieldsBlock}

INTERNAL LINKS ALREADY PLACED in sections you are NOT fixing (do not duplicate these):
${alreadyUsed}

${linksBlock}

RULES:
- Fix every issue listed above — do not skip any
- British English throughout, no colons in headings, sentence case, no em dashes
- For main_content: minimum 300 words, at least 2 H3 subheadings, exactly 1 internal link + at least 1 external link, no sentence over 20 words
- Across all sections combined: minimum 4 external links total — add to whichever sections you are fixing until the article-wide total reaches 4${brokenUrls && brokenUrls.length > 0 ? `\n- The following external URLs were found to be BROKEN (404/unreachable) — do NOT reuse any of them; replace with working official sources:\n${brokenUrls.map((u) => `  • ${u}`).join("\n")}` : ""}
- Preserve all existing HTML structure within the fields you are fixing
- Do NOT change fields that are not listed above
- Return ONLY raw JSON — no markdown, no code fences, no explanation

Return this exact JSON shape with ONLY the fields that need fixing plus updated link arrays:
{
  ${fieldsToFix.map((f) => `"${f}": "string"`).join(",\n  ")},
  "internal_links_used": [{"anchor": "string", "url": "string"}],
  "external_links_used": [{"anchor": "string", "url": "string"}]
}

The "internal_links_used" and "external_links_used" arrays must include ALL links in the full article — both the ones already placed in untouched sections and any new ones you add.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.5,
    max_completion_tokens: 12000,
  }, { signal: AbortSignal.timeout(90_000) });

  if (response.choices[0]?.finish_reason === "length") {
    throw new Error("fixBlogContent response was cut off — increase max_completion_tokens");
  }

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`fixBlogContent: no JSON in response. Raw: ${raw.slice(0, 200)}`);

  const fixes = JSON.parse(jsonMatch[0]) as Partial<BlogContent>;

  // Safe merge: only apply non-empty values from GPT so a truncated response
  // can't wipe fields that were already good.
  const safeUpdates: Partial<BlogContent> = {};
  for (const [k, v] of Object.entries(fixes)) {
    if (typeof v === "string" && v.trim()) {
      safeUpdates[k as keyof BlogContent] = v as never;
    } else if (Array.isArray(v) && v.length > 0) {
      safeUpdates[k as keyof BlogContent] = v as never;
    }
  }

  // Enforce meta description ceiling so a bad GPT rewrite can't re-fail the check.
  if (safeUpdates.meta_description) {
    const md = safeUpdates.meta_description as string;
    if (md.length > 141) {
      safeUpdates.meta_description = md.slice(0, 141) as never;
    }
  }

  // Validate slug: must be lowercase hyphenated — reject if GPT returned garbage.
  if (safeUpdates.slug && !/^[a-z0-9-]+$/.test(safeUpdates.slug as string)) {
    delete safeUpdates.slug;
    console.warn("[fixBlogContent] GPT returned an invalid slug — keeping previous value");
  }

  return { ...previousContent, ...safeUpdates };
}

// ── Image generation ──────────────────────────────────────────

export type ImageModel = "imagen-4" | "gpt-image-1";

/**
 * Generate an image and return it as a Buffer.
 * Supports Imagen 4 (Google AI Studio) and GPT-image-1 (OpenAI).
 */
export async function generateImage(prompt: string, model: ImageModel = "imagen-4"): Promise<Buffer> {
  if (model === "gpt-image-1") {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    }, { signal: AbortSignal.timeout(90_000) });

    const b64 = response.data?.[0]?.b64_json;
    if (b64) return Buffer.from(b64, "base64");

    const url = response.data?.[0]?.url;
    if (url) {
      const res = await fetch(url);
      return Buffer.from(await res.arrayBuffer());
    }

    throw new Error("GPT-image-1 returned no image data");
  }

  // Default: Imagen 4
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const timeoutMs = 90_000;
  const imagenPromise = ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: "16:9",
    },
  });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Imagen 4 timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  const response = await Promise.race([imagenPromise, timeoutPromise]);

  const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imageBytes) throw new Error("Imagen 4 returned no image data");

  return Buffer.from(imageBytes, "base64");
}
