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
export async function generateBlueprint(
  title: string,
  selectedLinks: SelectedLinks,
  sourceBrief?: SourceBrief,
  strategy?: StrategyBrief | null
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

  const userPrompt = `Blog title: "${title}"
Available link topics for context: ${linkCategories}
${strategyBlock}${sourceBriefBlock ? `\n${sourceBriefBlock}\n` : ""}

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

- meta_description: STRICT RULES — all must be met simultaneously:
  1. Exactly 145–155 characters including spaces — count precisely before returning
  2. Place the exact focus keyword within the first 60 characters
  3. State clearly what the reader gets from this article — a specific benefit (cost, timeline, process, comparison, or decision framework)
  4. End with a soft CTA: "Learn how Aston VIP can help." or "Speak to our advisers today." or "Find out what applies to you."
  5. Active voice, present tense, no passive constructions
  6. Must not repeat the seo_title verbatim — complement it, do not duplicate it
  7. Never use banned phrases: seamless, hassle-free, comprehensive, robust, tailored, one-stop

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
  });

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
    return JSON.parse(jsonMatch[0]) as Blueprint;
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
  strategy?: StrategyBrief | null
): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const linksBlock = formatLinksForPrompt(selectedLinks);
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

  const userPrompt = `Blog title: "${title}"
${strategyContentBlock}${sourceBriefBlock ? `\n${sourceBriefBlock}\n` : ""}
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

main_content (180-220 words):
- Open with the business problem or opportunity described in the intro angle: "${blueprint.intro_angle}"
- The focus keyword must appear in the first sentence of the first paragraph — not the second, not the third
- Use the focus keyword 2–3 times naturally across the full intro (spread across different paragraphs)
- Do NOT open with an H3. Start with a <p> tag
- After the opening paragraph you may use H3/H4 for any subsections if needed
- Heading hierarchy: every H4 must sit under an H3. Never skip levels
- End with a sentence that pulls the reader into what follows
- Allowed HTML: <h3>, <h4>, <p>, <strong>, <em>

keypoint_one:
A single compelling sentence (max 25 words) from the key insight of main_content. Bold editorial statement. No em dashes. No question marks.

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
A single compelling sentence (max 25 words) from the key insight of more_content_3. Bold editorial statement. No em dashes. No question marks. Different from keypoint_one.

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
HTML <ul><li> list of 4 to 6 items. This section appears directly after the title — before the introduction. ${strategy ? "Use and refine the PRE-PLANNED KEY TAKEAWAYS provided above — adapt them to match the final article content. Each must be a standalone advisory sentence with real decision-useful insight about structure, banking, tax, licensing, regulation, or jurisdiction logic. Not marketing. Not vague summaries." : "Each must contain at least one named figure, regulator, jurisdiction, timeline, or cost. Include the focus keyword in at least one item."}
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
    max_completion_tokens: 16000,
  });

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
    return JSON.parse(jsonMatch[0]) as BlogContent;
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

  const strip = (html: string) =>
    html.slice(0, 300).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const userPrompt = `You have just written a blog post titled: "${title}"

Here is a summary of the four content sections that need images:

SECTION 1 (keypoint_one image — covers: ${strip(content.main_content)}...)

SECTION 2 (keypoint_two image — covers: ${strip(content.more_content_3)}...)

SECTION 3 (post split image — wide-angle architectural or setting image for the overall topic jurisdiction)

SECTION 4 (featured hero image — represents the entire article, wide-angle editorial feel with professionals)

Write 4 DALL·E image prompts. Each must:
- Directly reference a scene from that section's actual content — no generic office photos
- Apply Aston VIP visual style: clean corporate photography, bright and airy, natural daylight or soft indoor lighting, suited professionals (where included), modern glass buildings or high-end offices, neutral whites/warm greys/soft golds, no oversaturated colours
- Never include: text, logos, watermarks, flags, clocks, screens with visible content
- End with: "shot on Canon EOS R5, 35mm lens, sharp focus, high resolution, professional corporate photography, no text, no logos"
- Location: UAE/DIFC/ADGM topics use Dubai settings. Non-UAE use relevant city. Mixed use neutral international office
- 2-3 sentences maximum

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

Alt text rules: describe what is literally shown using specific nouns, include one relevant keyword naturally, max 125 characters, no keyword stuffing.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.5,
    max_completion_tokens: 2000,
  });

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

// ── DALL·E 3 image generation ─────────────────────────────────

/**
 * Generate an Imagen 3 image via Google AI Studio and return it as a Buffer.
 * Buffer avoids writing to disk — clean for serverless environments.
 */
export async function generateImage(prompt: string): Promise<Buffer> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const response = await ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: "16:9",
      outputMimeType: "image/png",
    },
  });

  const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imageBytes) throw new Error("Imagen 3 returned no image data");

  return Buffer.from(imageBytes, "base64");
}
