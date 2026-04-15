/**
 * lib/openai.ts
 * ─────────────────────────────────────────────────────────────
 * All OpenAI interactions: GPT-4o for blog content,
 * DALL·E 3 for realistic images.
 */

import OpenAI from "openai";
import axios from "axios";
import { BlogContent } from "./wordpress";

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
seamless, hassle-free, empower, unlock the power of, cutting-edge, innovative solution, game-changing, leverage, next-gen, disrupt, frictionless, one-stop-shop, solution-oriented, obtain, delve, navigate the complexities, it's worth noting, in today's landscape, in conclusion, unlock, streamline, robust, comprehensive suite, tailored solutions, ever-evolving, look no further

ASTON VIP VISUAL STYLE — apply to all 4 image prompts:
- Style: clean corporate photography, bright and airy
- Lighting: natural daylight or soft indoor lighting, never dark or moody
- People: suited professionals where included, diverse but formal
- Architecture: modern glass buildings, high-end offices, financial districts
- Colour palette: neutral whites, warm greys, soft golds — no oversaturated colours
- Never include: text, logos, watermarks, flags, clocks, screens with visible content
- Always end every image prompt with this quality string: "shot on Canon EOS R5, 35mm lens, sharp focus, high resolution, professional corporate photography, no text, no logos"
- Location rule: if the topic relates to UAE/DIFC/ADGM use Dubai settings. If non-UAE use the relevant international city or neutral high-end office. If mixed jurisdictions use a neutral international office setting`;

/**
 * Generate full structured blog post content using GPT-4o.
 * Returns a typed BlogContent object ready for WordPress.
 */
export async function generateBlogContent(title: string): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPrompt = `Blog title: "${title}"

Based on this title, do the following before writing:
1. Identify the primary focus keyword this article should rank for
2. Identify 4-6 secondary keywords or LSI terms to support it
3. Use these throughout the article as instructed

Then write the full blog post and return it as a single valid JSON object with exactly these fields. No markdown, no code fences, no text before or after the JSON:

{
  "focus_keyword": "string",
  "secondary_keywords": ["string", "string", "string", "string"],
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
  "keypoint_one_img_prompt": "string",
  "keypoint_one_img_alt": "string",
  "keypoint_two_img_prompt": "string",
  "keypoint_two_img_alt": "string",
  "post_split_img_prompt": "string",
  "post_split_img_alt": "string",
  "featured_img_prompt": "string",
  "featured_img_alt": "string"
}

FIELD INSTRUCTIONS:

focus_keyword:
The single primary keyword phrase this article targets for Google ranking. Example: "DIFC fund manager licence". Return as a plain string.

secondary_keywords:
A JSON array of 4-6 related keyword phrases used naturally within the article body.

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
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>

more_content_2 (350-450 words):
- Cover requirements, eligibility, process steps, or common mistakes
- Open with an H3 heading
- Under each H3 use at least two H4 subsections. Under each H4 use H5 sub-points where appropriate
- Heading hierarchy rule: every H4 must sit under an H3, every H5 must sit under an H4. Never skip levels
- Must include a bulleted or numbered list of at least 4 concrete items — actual documents, named steps, real costs, or specific eligibility conditions. No vague items. Each must contain a fact, figure, or named detail
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>

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
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>

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

keypoint_one_img_prompt:
A complete ready-to-send DALL-E prompt for more_content_1. Describe a specific scene directly relevant to the first major angle of the article. Not abstract. Apply full Aston VIP visual style. End with the quality string. 2-3 sentences maximum.

keypoint_one_img_alt:
SEO-optimised alt text for the keypoint one image. Describe what is literally shown in the image using specific nouns. Naturally include one relevant keyword. Maximum 125 characters. No keyword stuffing. Example: "Corporate advisor reviewing DIFC fund manager licence documents in a modern Dubai office."

keypoint_two_img_prompt:
A complete ready-to-send DALL-E prompt for more_content_3. Must show a different scene and setting from keypoint_one_img_prompt. Apply full Aston VIP visual style. End with the quality string. 2-3 sentences maximum.

keypoint_two_img_alt:
SEO-optimised alt text for the keypoint two image. Describe what is literally shown in the image using specific nouns. Naturally include one relevant keyword. Maximum 125 characters. No keyword stuffing. Example: "Two professionals in a glass-walled London boardroom discussing international company formation."

post_split_img_prompt:
A complete ready-to-send DALL-E prompt for a wide-angle architectural image relevant to the topic jurisdiction. Minimal or no people. Apply full Aston VIP visual style. End with the quality string. 2-3 sentences maximum.

post_split_img_alt:
SEO-optimised alt text for the post split image. Describe the architecture or setting shown. Naturally include a jurisdiction or location keyword. Maximum 125 characters. No keyword stuffing. Example: "Wide-angle view of the DIFC financial district in Dubai at midday, glass towers and open plaza."

featured_img_prompt:
A complete ready-to-send DALL-E prompt for the full-width hero image representing the entire article. Must include a suited professional or small group. Wide-angle, premium, editorial feel. Apply full Aston VIP visual style. End with the quality string. 2-3 sentences maximum.

featured_img_alt:
SEO-optimised alt text for the featured hero image. Describe the people and setting shown. Naturally include the primary focus keyword or a close variant. Maximum 125 characters. No keyword stuffing. Example: "Business advisor and client discussing ADGM company setup in a bright Dubai office."

INTERNAL LINKS — include 3-5 naturally within body content using descriptive anchor text. Only use URLs from this verified list. Do not fabricate URLs. Do not force irrelevant links:

https://aston.ae/100-foreign-ownership-dubai/
https://aston.ae/accounting-bookkeeping-dubai/
https://aston.ae/adgm-cat-4-license-categories-benefits/
https://aston.ae/adgm-hedge-funds/
https://aston.ae/adgm-public-register/
https://aston.ae/advantages-of-setting-up-in-adgm/
https://aston.ae/aisp-and-pisp-licensing-in-the-difc/
https://aston.ae/alternative-trading-system-in-the-difc/
https://aston.ae/anti-money-laundering-aml-policy/
https://aston.ae/aston-ae-business-audit-dubai/
https://aston.ae/business-in-dubai-guide/
https://aston.ae/business-setup-dubai/
https://aston.ae/business-setup-dubai/business-setup-dubai-mainland-company-setup/
https://aston.ae/business-setup-dubai/crypto-company-setup-dubai/
https://aston.ae/business-setup-dubai/cyprus-trust-dubai/
https://aston.ae/business-setup-dubai/dmcc-business-setup-dubai/
https://aston.ae/business-setup-dubai/ifza-business-setup/
https://aston.ae/business-setup-dubai/vara-license/
https://aston.ae/category-3c-difc-fund-manager-licence/
https://aston.ae/category-4-difc-investment-advisory-licence/
https://aston.ae/contact-us/
https://aston.ae/corporate-banking/
https://aston.ae/defi-and-dapps-in-the-difc/
https://aston.ae/dfsa-licensing-in-dubai-requirements/
https://aston.ae/dfsa-tokenisation-regulatory-sandbox/
https://aston.ae/difc-active-enterprises/
https://aston.ae/difc-category-3a-brokerage-licence/
https://aston.ae/difc-digital-assets-regime/
https://aston.ae/difc-digital-assets-regime-crypto-tokens/
https://aston.ae/difc-employment-law-your-comprehensive-guide/
https://aston.ae/difc-investment-crowdfunding-business-license-explained/
https://aston.ae/difc-licensing-categories/
https://aston.ae/difc-loan-crowdfunding-business-licence/
https://aston.ae/difc-venture-studio-launchpad-licence/
https://aston.ae/difc-innovation-market-explorer-licences/
https://aston.ae/electronic-money-institution-licenses-in-the-difc/
https://aston.ae/foundation-set-up-in-dubai-how-to-get-started/
https://aston.ae/freezone/abu-dhabi-global-market-adgm/
https://aston.ae/freezone/dubai-international-financial-centre-difc/
https://aston.ae/freezone/international-free-zone-authority-ifza/
https://aston.ae/get-local-bank-account/
https://aston.ae/general-data-protection-regulation-gdpr-compliance-aston-vip/
https://aston.ae/gold-trade/
https://aston.ae/how-to-apply-for-adgm-category-3c-license/
https://aston.ae/how-to-get-approved-vara-license-in-dubai/
https://aston.ae/how-to-get-vara-license-dubai/
https://aston.ae/how-to-setup-a-business-bank-account-in-dubai/
https://aston.ae/how-to-setup-an-adgm-spv-in-the-uae/
https://aston.ae/how-to-start-a-commodities-trading-company-in-dubai/
https://aston.ae/investment-token-funds-in-the-difc/
https://aston.ae/large-cash-transactions/
https://aston.ae/legal/
https://aston.ae/navigating-offshore-company-registration-in-the-uae/
https://aston.ae/non-fungible-tokens-uae/
https://aston.ae/oil-fuel-trading-dubai/
https://aston.ae/open-company-bank-account-in-dubai/
https://aston.ae/open-private-bank-account-in-dubai/
https://aston.ae/procedures-to-llc-company-formation-in-dubai/
https://aston.ae/relocation-services/
https://aston.ae/securing-dubai-crypto-exchange-license/
https://aston.ae/start-free-zone-dwtc/
https://aston.ae/starting-a-business-in-ifza-free-zone/
https://aston.ae/step-by-step-process-to-company-liquidation-in-dubai/
https://aston.ae/tax-consultancy/
https://aston.ae/tokenisation-of-real-estate-in-the-uae/
https://aston.ae/tokenised-real-estate-crowdfunding-platform-in-the-difc/
https://aston.ae/uae-freezones/
https://aston.ae/vara-broker-dealer-licences/
https://aston.ae/vip/
https://aston.ae/vip-residence-visa/
https://aston.ae/virtual-assets-service-providers-in-difc-and-why-the-centre-attracts/
https://aston.ae/virtual-assets-service-providers-in-the-adgm/
https://aston.ae/virtual-assets-service-providers-in-the-uae/

EXTERNAL LINKS — include up to 4 where genuinely relevant. Only use these:
https://www.dfsa.ae
https://www.difc.ae
https://www.adgm.com
https://www.fatf-gafi.org
https://www.imf.org`;

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

  // Extract the first complete JSON object — handles any stray text GPT adds
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

/**
 * Generate a DALL·E 3 image and return it as a Buffer.
 * Returning a buffer means we never write to disk —
 * cleaner for serverless environments like Vercel.
 */
export async function generateImage(prompt: string): Promise<Buffer> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1792x1024",
    quality: "hd",
    style: "natural", // More photorealistic than "vivid"
  });

  const imageUrl = response.data?.[0]?.url ?? '';
  if (!imageUrl) throw new Error('DALL·E returned no image URL');

  // Download image as buffer — no temp files needed on Vercel
  const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
  return Buffer.from(imageResponse.data);
}
