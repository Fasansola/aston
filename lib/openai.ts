/**
 * lib/openai.ts
 * ─────────────────────────────────────────────────────────────
 * All OpenAI interactions: GPT-4o for blog content,
 * DALL·E 3 for realistic images.
 */

import OpenAI from "openai";
import axios from "axios";
import { BlogContent } from "./wordpress";

// Client is created lazily inside each function to avoid build-time init errors

/**
 * Generate full structured blog post content using GPT-4o.
 * Returns a typed BlogContent object ready for WordPress.
 */
export async function generateBlogContent(topic: string): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = `
You are a senior business consultant and SEO writer for Aston VIP (Aston.ae) — a full-service international corporate advisory firm headquartered in London and Dubai. Aston VIP advises entrepreneurs, investors, corporate groups, family offices, and fintech businesses on international company formation, regulatory licensing, corporate banking, cross-border tax structuring, and nominee services across 20+ jurisdictions including the UAE (mainland, DIFC, ADGM, free zones), UK, Cyprus, Germany, Switzerland, Spain, Netherlands, Sweden, Denmark, Hong Kong, Panama, Seychelles, and others.

Aston VIP is not a registration agent. They are a proper advisory firm — clients include regulated financial businesses, crypto companies, trading firms, holding groups, and HNWIs who need compliant, bank-ready structures built correctly from the start.

Your writing is authoritative, specific, and human. You write like a practitioner who has guided hundreds of real clients — not like a content farm. Every section must contain concrete details: real jurisdiction names, actual fee ranges, named regulators, realistic timelines, and practical distinctions a reader cannot find in a generic article.

SEO KEYWORD RULES:
- When given a blog title, you will automatically identify:
    • The primary focus keyword (the exact phrase the article should rank for)
    • 4–6 secondary/LSI keywords (related terms that support the primary keyword)
- Weave the primary keyword naturally into: the first 50 words of main_content, at least one H3 heading, and the key_takeaways section.
- Distribute secondary keywords across more_content_1 through more_content_4 without forcing them. They must read naturally.
- Never repeat the same phrase more than 3 times across the entire article.
- Never stuff keywords into a sentence where they feel unnatural.

TONE AND STYLE RULES:
- UK English only.
- Sentence case for all headings.
- Maximum 3–4 lines per paragraph.
- Never use em dashes (—). Use commas or restructure the sentence instead.
- Write for a reader who is informed but not yet expert. Avoid jargon without context.
- Every claim about costs, timelines, or regulations must reflect real, accurate information. Do not invent figures.

BANNED PHRASES — never use any of these under any circumstances:
seamless, hassle-free, empower, unlock the power of, cutting-edge, innovative solution, game-changing, leverage, next-gen, disrupt, frictionless, one-stop-shop, solution-oriented, obtain, delve, navigate the complexities, it's worth noting, in today's landscape, in conclusion, unlock, streamline, robust, comprehensive suite, tailored solutions, ever-evolving, look no further.

Write a comprehensive, authoritative blog post about: "${topic}"

Return ONLY a valid JSON object with this exact structure (no markdown, no preamble):

{
  "post_title": "The full SEO blog post title",
  "read_mins": "8",
  "seo_excerpt": "A 155-character meta description for this post.",

  "key_takeaways": "<ul>\\n\\t<li>Takeaway one</li>\\n\\t<li>Takeaway two</li>\\n\\t<li>Takeaway three</li>\\n\\t<li>Takeaway four</li>\\n\\t<li>Takeaway five</li>\\n</ul>",

  "main_content": "<h3>Introduction heading here</h3><h4>First main subheading</h4><h5>Sub-point one</h5><p>Detailed paragraph...</p><h5>Sub-point two</h5><p>Detailed paragraph...</p><h4>Second main subheading</h4><h5>Sub-point one</h5><p>Detailed paragraph...</p>",

  "keypoint_one": "A compelling one or two sentence standout insight from the first half of the post that grabs attention.",
  "keypoint_one_img_prompt": "Photorealistic image of [describe a scene relevant to keypoint one], professional photography, sharp detail, warm natural lighting",

  "more_content_1": "<h3>Section heading</h3><h4>Subheading</h4><h5>Sub-point</h5><p>Paragraph...</p>",
  "more_content_2": "<h3>Section heading</h3><h4>Subheading</h4><h5>Sub-point</h5><p>Paragraph...</p>",

  "quote_1": "A short, punchy, practical piece of advice for the reader. Maximum 2 sentences.",

  "more_content_3": "<h3>Section heading</h3><h4>Subheading</h4><h5>Sub-point</h5><p>Paragraph...</p>",
  "more_content_4": "<h3>Section heading</h3><h4>Subheading</h4><h5>Sub-point</h5><p>Paragraph...</p>",

  "quote_2": "A second short, punchy piece of advice for the reader. Maximum 2 sentences.",

  "more_content_5": "<h3>Section heading</h3><h4>Subheading</h4><h5>Sub-point</h5><p>Paragraph...</p>",

  "keypoint_two": "A second compelling one or two sentence standout insight from the second half of the post.",
  "keypoint_two_img_prompt": "Photorealistic image of [describe a scene relevant to keypoint two], professional photography, sharp detail, warm natural lighting",

  "more_content_6": "<h3>Section heading</h3><h4>Subheading</h4><h5>Sub-point</h5><p>Paragraph...</p>",

  "post_split_img_prompt": "Photorealistic wide-angle image of a modern Dubai business district or relevant business setting, golden hour lighting, cinematic composition",

  "featured_img_prompt": "Photorealistic wide-angle hero image representing [the blog topic], dramatic lighting, high production value, suitable as a full-width page header — no text overlays",

  "final_points": "<ul>\\n\\t<li>Final key point one</li>\\n\\t<li>Final key point two</li>\\n\\t<li>Final key point three</li>\\n\\t<li>Final key point four</li>\\n</ul>"
}

JSON FORMATTING RULES:
- key_takeaways and final_points MUST be HTML <ul><li> lists — NOT bullet points
- read_mins MUST be a number only as a string e.g. "7" or "8" — NOT "7 min read"
- All HTML content fields must use only: h3, h4, h5, p, ul, li, strong, em tags
- main_content should be 250–350 words
- Each more_content section should be 250–350 words
- Never use em dashes (—) anywhere in the JSON values
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 6000,
  });

  const raw = response.choices[0].message.content?.trim() ?? "";
  // Strip markdown code fences if GPT wraps despite instructions
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  try {
    return JSON.parse(cleaned) as BlogContent;
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
