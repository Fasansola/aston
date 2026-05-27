/**
 * scripts/backfill-alt-text.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Backfills missing alt text on WordPress media items using GPT-4o vision.
 * Only processes images where alt_text is currently empty.
 * Safe to re-run — progress is saved and resumes where it left off.
 *
 * Usage:
 *   node scripts/backfill-alt-text.mjs             ← live run (all missing)
 *   node scripts/backfill-alt-text.mjs --dry-run   ← preview only, no changes
 *   node scripts/backfill-alt-text.mjs --limit=20  ← process first 20 only
 *
 * Progress saved to: scripts/alt-text-progress.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ───────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
  console.log("✅ .env.local loaded");
} else {
  console.warn("⚠️  .env.local not found — relying on shell environment variables");
}

// ── Validate env vars ─────────────────────────────────────────────────────────
const WP_URL          = process.env.WP_URL;
const WP_USERNAME     = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

const missing = ["WP_URL","WP_USERNAME","WP_APP_PASSWORD","OPENAI_API_KEY"]
  .filter(k => !process.env[k]);

if (missing.length > 0) {
  console.error(`❌  Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const WP_AUTH    = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");
const WP_HEADERS = {
  Authorization:  `Basic ${WP_AUTH}`,
  "Content-Type": "application/json",
  "User-Agent":   "AstonAltTextBackfill/1.0",
};

// ── CLI args ──────────────────────────────────────────────────────────────────
const isDryRun  = process.argv.includes("--dry-run");
const limitArg  = process.argv.find(a => a.startsWith("--limit="));
const limit     = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const CONCURRENCY = 5;
const PROGRESS_FILE = path.join(__dirname, "alt-text-progress.json");

// ── Progress tracking ─────────────────────────────────────────────────────────
let progress = { processed: {}, errors: [] };

if (fs.existsSync(PROGRESS_FILE)) {
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    const doneCount = Object.keys(progress.processed).length;
    if (doneCount > 0) {
      console.log(`📂 Resuming — ${doneCount} images already done from a previous run\n`);
    }
  } catch {
    console.warn("⚠️  Could not read progress file — starting fresh");
    progress = { processed: {}, errors: [] };
  }
}

function saveProgress() {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── 1. Fetch all WP media with empty alt text ─────────────────────────────────
async function fetchMissingAltMedia() {
  const items     = [];
  let   page      = 1;
  let   totalPages = 1;
  const PER_PAGE  = 100;

  console.log("🔍 Scanning WordPress media library for missing alt text…\n");

  while (page <= totalPages) {
    const url = new URL(`${WP_URL}/wp-json/wp/v2/media`);
    url.searchParams.set("per_page",   PER_PAGE);
    url.searchParams.set("page",       page);
    url.searchParams.set("media_type", "image");
    url.searchParams.set("_fields",    "id,alt_text,source_url,title,slug");

    let res;
    try {
      res = await fetch(url.toString(), { headers: WP_HEADERS });
    } catch (err) {
      console.error(`\n❌  Network error on page ${page}:`, err.message);
      break;
    }

    if (res.status === 400) break; // WP returns 400 past last page
    if (!res.ok) {
      console.error(`\n❌  WP media fetch failed (${res.status}) on page ${page}`);
      break;
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    // Only collect images with no alt text
    const missing = data.filter(m => !m.alt_text?.trim());
    items.push(...missing);

    if (page === 1) {
      totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1", 10);
      const totalMedia = res.headers.get("X-WP-Total") ?? "?";
      console.log(`   Total media in library : ${totalMedia}`);
      console.log(`   Pages to scan          : ${totalPages}`);
    }

    process.stdout.write(
      `\r   Page ${String(page).padStart(3)} / ${totalPages}  ·  ${items.length} missing alt text so far`
    );

    page++;
    if (page <= totalPages) await delay(150); // gentle on WP
  }

  console.log(`\n\n✅ Scan complete — ${items.length} images need alt text\n`);
  return items;
}

// ── 2. Generate alt text via GPT-4o vision ────────────────────────────────────
async function generateAltText(imageUrl, imageTitle) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model:      "gpt-4o",
      max_tokens: 60,
      messages: [
        {
          role:    "system",
          content: `You write SEO-optimised alt text for images on Aston VIP's website.

WHO ASTON VIP IS:
Aston VIP is a full-service international corporate advisory firm providing: business setup and company formation, cross-border group structuring, regulatory licensing, corporate and international banking, international tax advisory, nominee director and shareholder services, and offshore vehicles. Active in 19+ jurisdictions: UAE, UK, Germany, Netherlands, Switzerland, Hong Kong, Seychelles, Panama, and more. Offices in London and Dubai.

RULES — all must be followed:
1. Exactly 8–12 words
2. Keyword-rich — relate to Aston VIP's services, jurisdictions, or corporate topics visible in the image
3. Written as an SEO phrase — NOT a visual description
4. Do NOT start with "image of", "photo of", "picture of", "a ", "an ", "the "
5. No full stops, no quotes, no markdown, no HTML
6. If the image is abstract or decorative, relate it to corporate advisory, international business, or Aston VIP's services

GOOD examples:
- UAE free zone company formation for international entrepreneurs
- international corporate banking account opening for offshore companies
- London corporate advisory office for cross-border business structuring
- nominee director services for offshore holding company formation
- DIFC regulatory licensing requirements for financial services firms
- Seychelles offshore company formation for international asset protection

BAD examples (never write these):
- glass office tower reflecting sunlight at golden hour
- businesspeople shaking hands in a modern boardroom
- documents and calculator on an office desk

Return ONLY the alt text — no explanation, no punctuation at the end.`,
        },
        {
          role: "user",
          content: [
            {
              type:      "image_url",
              image_url: { url: imageUrl, detail: "low" }, // "low" = faster + cheaper
            },
            {
              type: "text",
              text: `Image filename / title: "${imageTitle}"\n\nWrite the SEO alt text (8–12 words, keyword-rich, topic-relevant to Aston VIP's services).`,
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GPT-4o failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json    = await res.json();
  const altText = json.choices?.[0]?.message?.content?.trim() ?? "";

  if (!altText) throw new Error("GPT-4o returned empty alt text");

  const wordCount = altText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) throw new Error(`Alt text too short (${wordCount} words): "${altText}"`);
  if (wordCount > 20) throw new Error(`Alt text too long (${wordCount} words): "${altText}"`);

  return altText;
}

// ── 3. Update WP media item ───────────────────────────────────────────────────
async function updateWordPressAltText(mediaId, altText) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media/${mediaId}`, {
    method:  "POST",
    headers: WP_HEADERS,
    body:    JSON.stringify({ alt_text: altText }),
    signal:  AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WP update failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

// ── 4. Process a single image ─────────────────────────────────────────────────
async function processImage(item, index, total) {
  const id    = String(item.id);
  const label = `[${String(index + 1).padStart(4)} / ${total}]`;

  // Already done in a previous run
  if (progress.processed[id]) {
    return { status: "skipped" };
  }

  const imageTitle = item.title?.rendered || item.slug || `media-${id}`;

  try {
    const altText = await generateAltText(item.source_url, imageTitle);

    if (!isDryRun) {
      await updateWordPressAltText(item.id, altText);
    }

    progress.processed[id] = {
      altText,
      url:    item.source_url,
      dryRun: isDryRun,
      ts:     new Date().toISOString(),
    };

    console.log(`\n  ✅ ${label} ID ${id}`);
    console.log(`     "${altText}"`);
    return { status: "ok", altText };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    progress.errors.push({ id, url: item.source_url, error: msg, ts: new Date().toISOString() });
    console.log(`\n  ❌ ${label} ID ${id} — ${msg}`);
    return { status: "error", error: msg };
  }
}

// ── 5. Concurrency pool ───────────────────────────────────────────────────────
async function runPool(items, concurrency) {
  const cap     = Math.min(items.length, isFinite(limit) ? limit : items.length);
  const sliced  = items.slice(0, cap);
  let   cursor  = 0;
  let   updated = 0;
  let   errors  = 0;
  let   skipped = 0;

  async function worker() {
    while (cursor < sliced.length) {
      const idx  = cursor++;
      const item = sliced[idx];
      const result = await processImage(item, idx, sliced.length);

      if (result.status === "ok")      updated++;
      else if (result.status === "error") errors++;
      else if (result.status === "skipped") skipped++;

      // Save progress every 10 images
      if ((updated + errors) % 10 === 0) saveProgress();

      await delay(200); // small gap between requests
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { total: sliced.length, updated, errors, skipped };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function hr() {
  return "─".repeat(60);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${hr()}`);
  console.log(`  Aston VIP — Alt Text Backfill`);
  console.log(`${hr()}`);
  console.log(`  Mode        : ${isDryRun ? "DRY RUN (no changes will be made)" : "LIVE"}`);
  console.log(`  Limit       : ${isFinite(limit) ? limit : "all"}`);
  console.log(`  Concurrency : ${CONCURRENCY} images at a time`);
  console.log(`  WP site     : ${WP_URL}`);
  console.log(`${hr()}\n`);

  const allMissing = await fetchMissingAltMedia();

  if (allMissing.length === 0) {
    console.log("✨ All images already have alt text. Nothing to do.\n");
    return;
  }

  // Filter out already-processed from previous runs
  const toProcess = allMissing.filter(item => !progress.processed[String(item.id)]);
  const alreadyDone = allMissing.length - toProcess.length;

  console.log(`${hr()}`);
  console.log(`  To process      : ${Math.min(toProcess.length, isFinite(limit) ? limit : toProcess.length)}`);
  if (alreadyDone > 0)
  console.log(`  Already done    : ${alreadyDone} (from previous run)`);
  if (isDryRun)
  console.log(`  ⚠️  DRY RUN — WordPress will NOT be updated`);
  console.log(`${hr()}\n`);

  if (isDryRun && toProcess.length > 0) {
    console.log("🔍 First 5 images that would be processed:\n");
    for (const item of toProcess.slice(0, 5)) {
      console.log(`   ID ${item.id}: ${item.source_url}`);
    }
    console.log(`\nRun without --dry-run to apply changes.\n`);
    return;
  }

  const { total, updated, errors, skipped } = await runPool(toProcess, CONCURRENCY);

  saveProgress();

  // Cost estimate (GPT-4o low-detail vision: ~$0.002125 per image)
  const estimatedCost = (updated * 0.002125).toFixed(2);

  console.log(`\n\n${hr()}`);
  console.log(`  ✅ Run complete`);
  console.log(`${hr()}`);
  console.log(`  Processed       : ${total}`);
  console.log(`  Updated         : ${updated}`);
  console.log(`  Skipped         : ${skipped}`);
  console.log(`  Errors          : ${errors}`);
  console.log(`  Est. API cost   : ~$${estimatedCost}`);
  console.log(`  Progress file   : scripts/alt-text-progress.json`);
  console.log(`${hr()}\n`);

  if (errors > 0) {
    console.log(`⚠️  ${errors} image(s) failed — see scripts/alt-text-progress.json for details\n`);
  }

  if (updated > 0 && !isDryRun) {
    console.log(`🎉 ${updated} images now have SEO-optimised alt text on aston.ae\n`);
  }
}

main().catch(err => {
  console.error("\n💥 Fatal error:", err.message);
  saveProgress(); // save whatever progress we made before crashing
  process.exit(1);
});
