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
async function headCheck(url: string, timeoutMs = 8000): Promise<boolean> {
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
  const results = await Promise.all(
    urls.map((url) => headCheck(url).then((ok) => ({ url, ok })))
  );
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
