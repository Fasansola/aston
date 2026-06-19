/**
 * app/api/media-alt-backfill/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/media-alt-backfill
 *
 * Processes one batch of WordPress media items with missing alt text.
 * Called repeatedly by the client until all images are done.
 *
 * Body:  { page: number }   — WP media page to process (starts at 1)
 * Returns: {
 *   results:    { id, url, altText, status }[]
 *   nextPage:   number | null   — null = all done
 *   totalPages: number
 *   totalMedia: number
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const maxDuration = 300;

const WP_URL      = process.env.WP_URL!;
const WP_USERNAME = process.env.WP_USERNAME!;
const WP_APP_PASS = process.env.WP_APP_PASSWORD!;
const WP_AUTH     = Buffer.from(`${WP_USERNAME}:${WP_APP_PASS}`).toString("base64");
const WP_HEADERS  = {
  Authorization:  `Basic ${WP_AUTH}`,
  "Content-Type": "application/json",
};

const PER_PAGE = 25; // images per batch — keeps each request well under 300s

// GPT-4o vision only accepts these formats — AVIF, SVG, BMP, TIFF etc. will be skipped
const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ── Fetch one page of WP media ─────────────────────────────────────────────
async function fetchMediaPage(page: number) {
  const url = new URL(`${WP_URL}/wp-json/wp/v2/media`);
  url.searchParams.set("per_page",   String(PER_PAGE));
  url.searchParams.set("page",       String(page));
  url.searchParams.set("media_type", "image");
  url.searchParams.set("_fields",    "id,alt_text,source_url,title,slug,mime_type");

  const res = await fetch(url.toString(), {
    headers: WP_HEADERS,
    signal:  AbortSignal.timeout(20_000),
  });

  if (res.status === 400) return { items: [], totalPages: 0, totalMedia: 0 };
  if (!res.ok) throw new Error(`WP media fetch failed (${res.status}) on page ${page}`);

  const items      = await res.json() as {
    id: number; alt_text: string; source_url: string;
    title: { rendered: string }; slug: string; mime_type: string;
  }[];
  const totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1", 10);
  const totalMedia = parseInt(res.headers.get("X-WP-Total")      ?? "0", 10);

  return { items, totalPages, totalMedia };
}

// ── Generate alt text via GPT-4o vision ───────────────────────────────────────
async function generateAltText(imageUrl: string, imageTitle: string): Promise<string> {
  const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // gpt-4o: this is a VISION task (reads an image_url). gpt-5.5 is a text
  // reasoning model and isn't the right fit / overran the 25s timeout.
  const response = await openai.chat.completions.create({
    model:      "gpt-4o",
    messages: [
      {
        role:    "system",
        content: `You write SEO-optimised alt text for images on Aston VIP's website.

WHO ASTON VIP IS:
Aston VIP is a full-service international corporate advisory firm providing business setup and company formation, cross-border group structuring, regulatory licensing, corporate and international banking, international tax advisory, nominee director and shareholder services, and offshore vehicles. Active across 19+ jurisdictions: UAE, UK, Germany, Netherlands, Switzerland, Hong Kong, Seychelles, Panama, and more. Offices in London and Dubai.

RULES:
1. Exactly 8–12 words
2. Keyword-rich — relate to Aston VIP's services, jurisdictions, or corporate topics visible in the image
3. Written as an SEO phrase — NOT a visual description
4. Never start with "image of", "photo of", "picture of", "a ", "an ", "the "
5. No full stops, no quotes, no markdown, no HTML
6. If abstract or decorative, relate it to corporate advisory, international business, or Aston VIP's services

GOOD: "UAE free zone company formation for international entrepreneurs"
GOOD: "international corporate banking account opening for offshore companies"
GOOD: "nominee director services for offshore holding company formation"
BAD: "glass office tower reflecting sunlight" (visual description)
BAD: "businesspeople shaking hands in boardroom" (visual description)

Return ONLY the alt text — nothing else.`,
      },
      {
        role: "user",
        content: [
          {
            type:      "image_url",
            image_url: { url: imageUrl, detail: "low" },
          },
          {
            type: "text",
            text: `Image title: "${imageTitle}"\n\nWrite the SEO alt text (8–12 words).`,
          },
        ],
      },
    ],
  }, { signal: AbortSignal.timeout(25_000) });

  const altText = response.choices[0]?.message?.content?.trim() ?? "";
  if (!altText) throw new Error("GPT-4o returned empty alt text");
  return altText;
}

// ── Update WP media alt text ───────────────────────────────────────────────────
async function updateAltText(mediaId: number, altText: string): Promise<void> {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media/${mediaId}`, {
    method:  "POST",
    headers: WP_HEADERS,
    body:    JSON.stringify({ alt_text: altText }),
    signal:  AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WP update failed (${res.status}): ${body.slice(0, 150)}`);
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { page = 1 } = await req.json().catch(() => ({ page: 1 })) as { page?: number };

  try {
    const { items, totalPages, totalMedia } = await fetchMediaPage(page);

    // Find items missing alt text AND in a format GPT-4o can read
    const missing = items.filter(m =>
      !m.alt_text?.trim() && SUPPORTED_MIME_TYPES.has(m.mime_type?.toLowerCase())
    );

    // Track unsupported formats so the UI can show a count
    const unsupported = items.filter(m =>
      !m.alt_text?.trim() && !SUPPORTED_MIME_TYPES.has(m.mime_type?.toLowerCase())
    );

    const results: { id: number; url: string; altText: string; status: "ok" | "skipped" | "unsupported" | "error"; error?: string }[] = [];

    // Add unsupported format items directly — no GPT call
    for (const item of unsupported) {
      results.push({ id: item.id, url: item.source_url, altText: "", status: "unsupported", error: item.mime_type });
    }

    // Process missing items concurrently (3 at a time to stay safe)
    const CONCURRENCY = 3;
    let idx = 0;

    async function worker() {
      while (idx < missing.length) {
        const item  = missing[idx++];
        const title = item.title?.rendered || item.slug || `media-${item.id}`;

        try {
          const altText = await generateAltText(item.source_url, title);
          await updateAltText(item.id, altText);
          results.push({ id: item.id, url: item.source_url, altText, status: "ok" });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          results.push({ id: item.id, url: item.source_url, altText: "", status: "error", error });
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // Items that already had alt text — mark as skipped
    const alreadyHad = items.filter(m => m.alt_text?.trim());
    for (const item of alreadyHad) {
      results.push({ id: item.id, url: item.source_url, altText: item.alt_text, status: "skipped" });
    }

    const nextPage = page < totalPages ? page + 1 : null;

    return NextResponse.json({ results, nextPage, totalPages, totalMedia, currentPage: page });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[media-alt-backfill] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
