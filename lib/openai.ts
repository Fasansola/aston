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
You are an expert business consultant writing SEO-optimised blog posts for Aston.ae,
a company that helps entrepreneurs and investors set up businesses in Dubai, UAE free
zones, and other offshore jurisdictions.

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

  "final_points": "<ul>\\n\\t<li>Final key point one</li>\\n\\t<li>Final key point two</li>\\n\\t<li>Final key point three</li>\\n\\t<li>Final key point four</li>\\n</ul>"
}

Rules:
- key_takeaways and final_points MUST be HTML <ul><li> lists — NOT bullet points
- read_mins MUST be a number only as a string e.g. "7" or "8" — NOT "7 min read"
- All other HTML content fields must use only: h3, h4, h5, p, ul, li, strong, em tags
- Each more_content section should be 150-250 words
- main_content should be 200-300 words
- Tone: professional, confident, helpful — not salesy
- Focus on practical, actionable information
- Topic must relate to business setup in Dubai/UAE or offshore jurisdictions
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 4000,
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
