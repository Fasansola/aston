/**
 * lib/linkScrubber.ts
 *
 * Two-pass external link enforcement:
 *
 * Pass 1 — enforceApprovedLinks(): synchronous, no network.
 *   Strips any external href that is NOT in the approved authority URL list.
 *   GPT ignores "use only approved URLs" instructions, so we enforce it here.
 *
 * Pass 2 — scrubBrokenExternalLinks(): async, HEAD-checks remaining URLs.
 *   Strips any approved URL that actually returns 4xx/5xx. Keeps the link on
 *   timeout/network errors (benefit of the doubt for slow gov sites).
 *
 * Always call enforceApprovedLinks first, then scrubBrokenExternalLinks.
 */

import type { BlogContent } from "./wordpress";

/**
 * Domains that are known to be inaccessible or return bot-blocking errors.
 * These are stripped unconditionally — before authority scoring and before
 * the HEAD-check pass — so they never appear in published posts.
 */
const BLOCKED_DOMAINS = new Set([
  "fsra.ae",        // ADGM FSRA — site inaccessible / consistently bot-blocked
]);

const LINK_FIELDS: (keyof BlogContent)[] = [
  "main_content",
  "more_content_1",
  "more_content_2",
  "more_content_3",
  "more_content_4",
  "more_content_5",
  "more_content_6",
];

const EXTERNAL_HREF_RE = /href="(https?:\/\/(?!(?:www\.)?aston\.ae)[^"]+)"/gi;

/**
 * Returns false (remove link) when we are confident the URL does not exist:
 *
 * REMOVE:
 *   404 — page definitively does not exist
 *   DNS failure (ENOTFOUND) — domain does not exist at all
 *   Connection refused (ECONNREFUSED) — nothing running at that address
 *
 * KEEP:
 *   403 / 405 / 429 — server responded but blocked the bot; page likely exists
 *     (government, regulator, and bank sites routinely do this via WAF)
 *   5xx — server error, transient; don't penalise a real page for a bad moment
 *   Timeout — inconclusive; slow servers should not lose their links
 *   2xx / 3xx — link is live
 */
async function headCheck(url: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AstonBlogTool/1.0)" },
    });
    // 404 = page definitively does not exist
    return res.status !== 404;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      const code = (err as NodeJS.ErrnoException).code ?? "";
      // DNS lookup failed → domain does not exist
      if (code === "ENOTFOUND" || msg.includes("enotfound") || msg.includes("getaddrinfo")) {
        return false;
      }
      // Connection refused → nothing at that address
      if (code === "ECONNREFUSED" || msg.includes("econnrefused")) {
        return false;
      }
    }
    // Timeout or other network error — benefit of the doubt
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLinkTag(html: string, url: string): string {
  return html.replace(
    new RegExp(`<a[^>]*href="${escapeRegex(url)}"[^>]*>(.*?)<\\/a>`, "gis"),
    "$1"
  );
}

/**
 * Pass 1 — synchronous, no network calls.
 * Removes any external <a> tag whose href is not in the approvedUrls set.
 * Keeps anchor text so the sentence reads naturally.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function enforceApprovedLinks(
  content: BlogContent,
  approvedUrls: string[]
): { content: BlogContent; removed: string[] } {
  if (approvedUrls.length === 0) return { content, removed: [] };

  // Match on domain, not exact URL — GPT writes specific page paths within
  // approved domains (e.g. dfsa.ae/rulebooks/...) which won't match the base
  // URL exactly. Any path on an approved domain is trusted; the HEAD-check
  // scrubber in pass 2 will catch pages that actually 404.
  const approvedDomains = new Set(approvedUrls.map(extractDomain).filter(Boolean));
  const removed: string[] = [];

  const cleaned = { ...content } as BlogContent;

  for (const field of LINK_FIELDS) {
    let html = (cleaned[field] as string) ?? "";
    EXTERNAL_HREF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const toStrip: string[] = [];

    while ((m = EXTERNAL_HREF_RE.exec(html)) !== null) {
      const domain = extractDomain(m[1]);
      if (!domain || BLOCKED_DOMAINS.has(domain) || !approvedDomains.has(domain)) {
        toStrip.push(m[1]);
      }
    }

    for (const url of toStrip) {
      html = stripLinkTag(html, url);
      removed.push(url);
    }

    (cleaned as unknown as Record<string, unknown>)[field] = html;
  }

  return { content: cleaned, removed };
}

/**
 * Pass 2 — async HEAD checks.
 * Scrubs any remaining external link that returns a non-2xx HTTP response.
 */
export async function scrubBrokenExternalLinks(content: BlogContent): Promise<{
  content: BlogContent;
  removed: string[];
}> {
  const urlSet = new Set<string>();

  for (const field of LINK_FIELDS) {
    const html = (content[field] as string) ?? "";
    EXTERNAL_HREF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXTERNAL_HREF_RE.exec(html)) !== null) {
      urlSet.add(m[1]);
    }
  }

  if (urlSet.size === 0) return { content, removed: [] };

  const urls = [...urlSet];

  // Hard 20s deadline for the entire scrub pass — if slow sites cause it to
  // run long the overall generation hits Vercel's 300s limit. URLs that don't
  // resolve within the deadline are kept (benefit of the doubt).
  const SCRUB_DEADLINE_MS = 20_000;
  const deadline = new Promise<{ url: string; ok: boolean }[]>((resolve) =>
    setTimeout(() => resolve(urls.map((url) => ({ url, ok: true }))), SCRUB_DEADLINE_MS)
  );

  const checks = Promise.all(
    urls.map((url) => headCheck(url).then((ok) => ({ url, ok })))
  );

  const results = await Promise.race([checks, deadline]);
  const broken = new Set(results.filter((r) => !r.ok).map((r) => r.url));

  if (broken.size === 0) return { content, removed: [] };

  const cleaned = { ...content } as BlogContent;
  for (const field of LINK_FIELDS) {
    let html = (cleaned[field] as string) ?? "";
    for (const url of broken) {
      html = stripLinkTag(html, url);
    }
    (cleaned as unknown as Record<string, unknown>)[field] = html;
  }

  return { content: cleaned, removed: [...broken] };
}

/**
 * Pass 3 — synchronous, no network calls.
 * Strips all <a> tags from inside infographic and chart visual blocks
 * so links never appear inside designed UI components.
 * Keeps the anchor text — only the <a> wrapper is removed.
 *
 * Works by scanning the HTML character by character to find the boundaries
 * of visual block divs, then stripping <a> tags only within those spans.
 */
export function stripLinksFromVisualBlocks(content: BlogContent): BlogContent {
  const cleaned = { ...content } as BlogContent;

  // Class prefixes that mark the start of a visual block
  const VISUAL_BLOCK_CLASSES = ["aston-visual-block", "aston-chart-block"];

  function stripLinksInVisualBlocks(html: string): string {
    let result = "";
    let i = 0;

    while (i < html.length) {
      // Look for a <div ... class="...aston-visual-block..." ...> opening tag
      const divStart = html.indexOf("<div", i);
      if (divStart === -1) {
        result += html.slice(i);
        break;
      }

      // Find the end of this opening tag
      const tagEnd = html.indexOf(">", divStart);
      if (tagEnd === -1) {
        result += html.slice(i);
        break;
      }

      const openTag = html.slice(divStart, tagEnd + 1);
      const isVisualBlock = VISUAL_BLOCK_CLASSES.some((cls) =>
        openTag.includes(`class="`) && openTag.includes(cls)
      );

      if (!isVisualBlock) {
        // Not a visual block — copy up to and including this div tag, advance
        result += html.slice(i, tagEnd + 1);
        i = tagEnd + 1;
        continue;
      }

      // It IS a visual block — find the matching closing </div> by tracking depth
      result += html.slice(i, divStart); // everything before this block
      let depth = 1;
      let j = tagEnd + 1;
      while (j < html.length && depth > 0) {
        const nextOpen  = html.indexOf("<div", j);
        const nextClose = html.indexOf("</div>", j);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          j = nextOpen + 4;
        } else {
          depth--;
          j = nextClose + 6;
        }
      }

      // blockHtml is everything from the opening <div> to the closing </div>
      const blockHtml = html.slice(divStart, j);
      // Strip <a> tags from the block content, keeping anchor text
      const strippedBlock = blockHtml.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");
      result += strippedBlock;
      i = j;
    }

    return result;
  }

  for (const field of LINK_FIELDS) {
    const html = (cleaned[field] as string) ?? "";
    if (!html) continue;
    (cleaned as unknown as Record<string, unknown>)[field] = stripLinksInVisualBlocks(html);
  }

  return cleaned;
}
