/**
 * lib/openai.ts
 * ─────────────────────────────────────────────────────────────
 * All OpenAI interactions: GPT-4o for blog content + SEO,
 * GPT-4o for content-aware image prompts, DALL·E 3 for images.
 *
 * Two-step generation:
 *  Step 1 — generateBlogContent(): full article text + SEO metadata
 *  Step 2 — generateImagePrompts(): 4 prompts written from actual content
 */

import OpenAI from "openai";
import axios from "axios";
import { BlogContent, ImagePrompts } from "./wordpress";
import { SelectedLinks, formatLinksForPrompt } from "./links";

// ── Fixed system prompt — never changes between requests ──────
const SYSTEM_PROMPT = `You are a senior business consultant and SEO writer for Aston VIP (Aston.ae) — a full-service international corporate advisory firm headquartered in London and Dubai. Aston VIP advises entrepreneurs, investors, corporate groups, family offices, and fintech businesses on international company formation, regulatory licensing, corporate banking, cross-border tax structuring, and nominee services across 20+ jurisdictions including the UAE (mainland, DIFC, ADGM, free zones), UK, Cyprus, Germany, Switzerland, Spain, Netherlands, Sweden, Denmark, Hong Kong, Panama, Seychelles, and others.

Aston VIP is not a registration agent. They are a proper advisory firm — clients include regulated financial businesses, crypto companies, trading firms, holding groups, and HNWIs who need compliant, bank-ready structures built correctly from the start.

Your writing is authoritative, specific, and human. You write like a practitioner who has guided hundreds of real clients — not like a content farm. Every section must contain concrete details: real jurisdiction names, actual fee ranges, named regulators, realistic timelines, and practical distinctions a reader cannot find in a generic article.

SEO KEYWORD RULES:
- When given a blog title, automatically identify the primary focus keyword and 4-6 secondary/LSI keywords
- Weave the primary keyword naturally into: the first 50 words of main_content, at least one H3 heading, and the key_takeaways section
- Distribute secondary keywords across more_content_1 through more_content_4 without forcing them
- Never repeat the same phrase more than 3 times across the entire article
- Never stuff keywords into a sentence where they feel unnatural

TONE AND STYLE RULES:
- UK English only
- Sentence case for all headings
- All headings (H3, H4, H5) must be no longer than 8 words or 60 characters including whitespace. If a heading would exceed this, rephrase it
- Maximum 3-4 lines per paragraph
- Never use em dashes. Use commas or restructure the sentence instead
- Write for a reader who is informed but not yet expert. Avoid jargon without context
- Every claim about costs, timelines, or regulations must reflect real, accurate information. Do not invent figures

BANNED PHRASES — never use any of these under any circumstances:
seamless, hassle-free, empower, unlock the power of, cutting-edge, innovative solution, game-changing, leverage, next-gen, disrupt, frictionless, one-stop-shop, solution-oriented, obtain, delve, navigate the complexities, it's worth noting, in today's landscape, in conclusion, unlock, streamline, robust, comprehensive suite, tailored solutions, ever-evolving, look no further`;

// ── Step 1: Generate blog content + SEO metadata ─────────────

/**
 * Generate full structured blog content using GPT-4o.
 * Does NOT generate image prompts — those come from generateImagePrompts()
 * after the content is written, so prompts reference actual article content.
 */
export async function generateBlogContent(
  title: string,
  selectedLinks: SelectedLinks
): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const linksBlock = formatLinksForPrompt(selectedLinks);

  const userPrompt = `Blog title: "${title}"

Before writing, do the following:
1. Identify the primary focus keyword this article should rank for
2. Identify 4-6 secondary keywords or LSI terms to support it
3. Write the SEO title, meta description, URL slug, and excerpt
4. Use these throughout the article as instructed

Then write the full blog post and return it as a single valid JSON object with exactly these fields. No markdown, no code fences, no text before or after the JSON:

{
  "focus_keyword": "string",
  "secondary_keywords": ["string", "string", "string", "string"],
  "seo_title": "string",
  "meta_description": "string",
  "slug": "string",
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
  "final_points": "string",
  "read_mins": "string",
  "internal_links_used": [{"anchor": "string", "url": "string"}],
  "external_links_used": [{"anchor": "string", "url": "string"}]
}

FIELD INSTRUCTIONS:

focus_keyword:
The single primary keyword phrase this article targets for Google ranking. Example: "DIFC fund manager licence". Return as a plain string.

secondary_keywords:
A JSON array of 4-6 related keyword phrases used naturally within the article body.

seo_title:
The page title tag for Google. 50-60 characters. Include the focus keyword near the front. Do not include "Aston VIP" or the site name. No pipes or dashes at the end. Example: "DIFC Fund Manager Licence: Requirements and Costs"

meta_description:
The meta description for Google. 145-155 characters. Include the focus keyword once. Write as an informative sentence that gives a clear reason to click. No calls to action like "click here".

slug:
URL-safe slug for the WordPress post. Lowercase, hyphens only, no slashes. 3-6 words. Example: "difc-fund-manager-licence"

excerpt:
A 2-3 sentence plain-text excerpt used in post listings. No HTML. 40-60 words. Summarise the article's key value for the reader.

main_content (350-450 words):
- Open with the business problem or opportunity this topic addresses. Make the reader feel the stakes in the first two sentences
- Include the focus keyword naturally within the first 50 words
- Introduce 2-3 key themes without listing them as bullets
- For UAE topics reference the specific jurisdiction (DIFC, ADGM, mainland, or relevant free zone) not "Dubai" generically
- For non-UAE topics reference Aston's international coverage and London/Dubai offices naturally
- End with a sentence that pulls the reader into what follows
- Do NOT open with an H3. Start with a P tag. After the opening paragraph, use H3 for major sub-sections, H4 for subsections within each H3, and H5 for individual sub-points
- Heading hierarchy rule: every H4 must sit under an H3, every H5 must sit under an H4. Never skip levels
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <strong>, <em>

keypoint_one:
A single compelling sentence (maximum 25 words) pulled from the key insight of main_content. Written as a bold editorial statement. No em dashes. No question marks. This is used as a callout quote in the page layout.

more_content_1 (350-450 words):
- Deep-dive into the first major angle of the topic
- Open with an H3 heading containing the focus keyword or a close variant
- Under each H3 use at least two H4 subsections. Under each H4 use H5 sub-points where appropriate
- Heading hierarchy rule: every H4 must sit under an H3, every H5 must sit under an H4. Never skip levels
- Must include at least one of: a specific cost or fee range in AED or USD, a named regulatory body, a realistic processing timeline, or a direct comparison between two jurisdictions or licence types
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

more_content_2 (350-450 words):
- Cover requirements, eligibility, process steps, or common mistakes
- Open with an H3 heading
- Under each H3 use at least two H4 subsections. Under each H4 use H5 sub-points where appropriate
- Heading hierarchy rule: every H4 must sit under an H3, every H5 must sit under an H4. Never skip levels
- Must include a bulleted or numbered list of at least 4 concrete items — actual documents, named steps, real costs, or specific eligibility conditions. No vague items. Each must contain a fact, figure, or named detail
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

quote_1:
A short, punchy, practical piece of advice directly relevant to the content in more_content_1 or more_content_2. Maximum 2 sentences. No em dashes. Written as actionable guidance the reader can apply immediately.

more_content_3 (350-450 words):
- Address who this topic is most relevant for
- Open with an H3 heading
- Under each H3 use at least two H4 subsections. Under each H4 use H5 sub-points where appropriate
- Heading hierarchy rule: every H4 must sit under an H3, every H5 must sit under an H4. Never skip levels
- Cover ideal client profiles, business types, investor categories, or industry sectors
- Include at least one real-world scenario written as a short narrative. Example: "A fintech founder relocating from London..." or "A family office looking to hold real estate across three markets..."
- Reference Aston's client base where appropriate: regulated financial businesses, crypto companies, trading firms, HNWIs, family offices, corporate groups
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>

keypoint_two:
A single compelling sentence (maximum 25 words) pulled from the key insight of more_content_3. Written as a bold editorial statement. No em dashes. No question marks. Different point from keypoint_one.

more_content_4 (350-450 words):
- Open with: <h3>Aston VIP's role in your [topic-relevant process]</h3> — adapt the ending to the specific topic
- Under the H3 use H4 subsections for each distinct service area (e.g. regulatory liaison, banking introductions, document preparation). Use H5 for specific detail points under each H4
- Heading hierarchy rule: every H4 must sit under an H3, every H5 must sit under an H4. Never skip levels
- Describe Aston's end-to-end involvement specific to this topic and jurisdiction. Do not describe Aston generically
- Where relevant mention: regulatory correspondence and authority liaison, document preparation and compliance review, corporate banking introductions, nominee director or shareholder services, cross-border tax structuring, Aston's London and Dubai offices as a differentiator
- Close with: <p>To discuss your situation, <a href="https://aston.ae/contact-us/">speak with our team</a>.</p>
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <strong>, <a>

quote_2:
A second short, punchy piece of advice directly relevant to Aston VIP's advisory process or the client outcome described in more_content_4. Maximum 2 sentences. No em dashes. Different from quote_1.

key_takeaways:
- HTML ul/li list of exactly 5 items
- Each item must be specific and factual, containing at least one named figure, regulator, jurisdiction, timeline, or cost
- Include the focus keyword or a close variant in at least one item
- BAD: <li>Dubai offers many business setup options.</li>
- GOOD: <li>DIFC Cat 4 licences require a minimum base capital of USD 10,000 and are regulated by the DFSA.</li>
- Allowed HTML: <ul>, <li>, <strong>

final_points:
- HTML ul/li list of exactly 4 items
- Practical next steps. Start each with a verb. Specific and actionable
- BAD: <li>Consider your options carefully.</li>
- GOOD: <li>Compare DIFC and ADGM licensing costs before committing to a jurisdiction, as fees and capital requirements differ significantly.</li>
- Allowed HTML: <ul>, <li>, <strong>

read_mins:
A number string only. Estimate at 200 words per minute. Example: "9"

internal_links_used:
JSON array of objects. For each internal link you placed in the article body, record the exact anchor text used and the URL. Example: [{"anchor": "DIFC fund manager licence", "url": "https://aston.ae/category-3c-difc-fund-manager-licence/"}]

external_links_used:
JSON array of objects. For each external link you placed in the article body, record the exact anchor text used and the URL. If none used, return an empty array.

${linksBlock}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.6,
    max_tokens: 8000,
  });

  const raw = response.choices[0].message.content?.trim() ?? "";

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

// ── Step 2: Generate content-aware image prompts ──────────────

/**
 * Generate 4 DALL·E image prompts based on the actual written content.
 * Called AFTER generateBlogContent() so prompts reference real sections.
 */
export async function generateImagePrompts(
  title: string,
  content: BlogContent
): Promise<ImagePrompts> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPrompt = `You have just written a blog post titled: "${title}"

Here is a summary of the four content sections that need images:

SECTION 1 (keypoint_one image — covers: ${content.main_content.slice(0, 300).replace(/<[^>]+>/g, " ").trim()}...)

SECTION 2 (keypoint_two image — covers: ${content.more_content_3.slice(0, 300).replace(/<[^>]+>/g, " ").trim()}...)

SECTION 3 (post split image — this is a wide-angle architectural or setting image for the overall topic jurisdiction)

SECTION 4 (featured hero image — represents the entire article, wide-angle editorial feel with professionals)

Now write 4 DALL·E image prompts for these sections. Each prompt must:
- Directly reference a scene or setting from that specific section's content
- Apply the Aston VIP visual style: clean corporate photography, bright and airy, natural daylight or soft indoor lighting, suited professionals (where included), modern glass buildings or high-end offices, neutral whites/warm greys/soft golds, no oversaturated colours
- Never include: text, logos, watermarks, flags, clocks, screens with visible content
- End with this exact quality string: "shot on Canon EOS R5, 35mm lens, sharp focus, high resolution, professional corporate photography, no text, no logos"
- Location: if topic is UAE/DIFC/ADGM use Dubai settings. If non-UAE use the relevant city. If mixed use a neutral international office
- Be 2-3 sentences maximum

Return as a single valid JSON object with exactly these fields. No markdown, no code fences:

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

ALT TEXT RULES (for all 4 alt fields):
- Describe what is literally shown in the image using specific nouns
- Naturally include one relevant keyword
- Maximum 125 characters
- No keyword stuffing
- Example: "Corporate advisor reviewing DIFC fund manager licence documents in a modern Dubai office."`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.5,
    max_tokens: 2000,
  });

  const raw = response.choices[0].message.content?.trim() ?? "";

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
 * Generate a DALL·E 3 image and return it as a Buffer.
 * Buffer avoids writing to disk — clean for serverless environments.
 */
export async function generateImage(prompt: string): Promise<Buffer> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1792x1024",
    quality: "hd",
    style: "natural",
  });

  const imageUrl = response.data?.[0]?.url ?? "";
  if (!imageUrl) throw new Error("DALL·E returned no image URL");

  const imageResponse = await axios.get(imageUrl, {
    responseType: "arraybuffer",
  });
  return Buffer.from(imageResponse.data);
}
