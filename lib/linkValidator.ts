/**
 * lib/linkValidator.ts
 * ─────────────────────────────────────────────────────────────
 * Live link validation engine.
 *
 * - Internal links: must belong to siteDomain, must return 2xx/3xx
 * - External links: scored by domain authority pattern; must meet
 *   minAuthorityScore and return a valid response
 */

export interface LinkValidationConfig {
  siteDomain: string;        // e.g. "aston.ae"
  minAuthorityScore: number; // e.g. 40
}

export interface LinkIssue {
  id: string;
  type: "internal" | "external";
  status: "passed" | "warning" | "failed" | "skipped";
  anchorText: string;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  authorityScore?: number;
  problem: string | null;
  suggestedFix: string | null;
  blocking: boolean;
  actions: Array<"auto_fix" | "find_better_source" | "edit" | "remove" | "recheck">;
}

export interface LinkValidationSummary {
  passed: number;
  warning: number;
  failed: number;
}

export interface LinkValidationResult {
  overallStatus: "passed" | "warning" | "failed";
  canPublish: boolean;
  summary: {
    internal: LinkValidationSummary;
    external: LinkValidationSummary;
  };
  issues: LinkIssue[];
}

// ── Domain helpers ─────────────────────────────────────────────

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isInternalLink(domain: string, siteDomain: string): boolean {
  return domain === siteDomain || domain.endsWith(`.${siteDomain}`);
}

function normaliseUrl(href: string, siteDomain: string): string | null {
  try {
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) return null;
    return new URL(href, `https://${siteDomain}`).toString();
  } catch {
    return null;
  }
}

// ── Authority scoring ──────────────────────────────────────────

export function scoreExternalDomain(domain: string): number {
  let score = 0;

  if (domain.endsWith(".gov"))       score += 60;
  if (domain.endsWith(".edu"))       score += 50;
  if (domain.includes("europa.eu")) score += 60;

  if (domain.includes("fca"))        score += 40;
  if (domain.includes(".gov."))      score += 30;
  if (domain.includes("bank"))       score += 25;
  if (domain.includes("authority")) score += 25;
  if (domain.includes("ministry"))  score += 25;
  if (domain.includes("official"))  score += 20;

  // Trusted TLDs by region
  if (domain.endsWith(".ae"))  score += 20;
  if (domain.endsWith(".uk"))  score += 20;
  if (domain.endsWith(".de"))  score += 20;
  if (domain.endsWith(".eu"))  score += 20;

  // Known authority sites
  const AUTHORITY_SITES = [
    "reuters.com", "bbc.com", "ft.com", "economist.com",
    "investopedia.com", "forbes.com", "bloomberg.com",
    "pwc.com", "deloitte.com", "kpmg.com", "ey.com",
    "imf.org", "worldbank.org", "bis.org", "oecd.org",
  ];
  if (AUTHORITY_SITES.some((s) => domain === s || domain.endsWith(`.${s}`))) score += 40;

  // Low-quality signals
  if (domain.includes("blog"))      score -= 20;
  if (domain.includes("affiliate")) score -= 40;
  if (domain.includes("casino"))    score -= 100;
  if (domain.includes("spam"))      score -= 100;

  return score;
}

// ── Fetch with timeout ─────────────────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  reason?: string;
}

async function safeFetch(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "AstonBlogTool/1.0 (link-validator)" },
    });

    // Some servers reject HEAD — fall back to GET
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "AstonBlogTool/1.0 (link-validator)" },
      });
    }

    return { ok: res.ok, status: res.status, finalUrl: res.url };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return { ok: false, status: null, finalUrl: null, reason: isAbort ? "timeout" : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Individual validators ──────────────────────────────────────

async function validateInternal(
  id: string,
  anchorText: string,
  url: string
): Promise<LinkIssue> {
  const res = await safeFetch(url);

  if (res.reason === "timeout") {
    return {
      id, type: "internal", status: "warning",
      anchorText, url, finalUrl: null, httpStatus: null,
      problem: "Request timed out — link may be slow or temporarily unavailable",
      suggestedFix: "Recheck this link before publishing",
      blocking: false,
      actions: ["recheck", "edit", "remove"],
    };
  }

  if (!res.ok) {
    return {
      id, type: "internal", status: "failed",
      anchorText, url, finalUrl: res.finalUrl, httpStatus: res.status,
      problem: `Returned ${res.status ?? "no response"} — this internal link is broken`,
      suggestedFix: "Replace with the closest valid Aston page or remove the link",
      blocking: true,
      actions: ["auto_fix", "edit", "remove", "recheck"],
    };
  }

  // Warn if redirect changed the URL significantly
  const redirected = res.finalUrl && res.finalUrl !== url;
  if (redirected) {
    return {
      id, type: "internal", status: "warning",
      anchorText, url, finalUrl: res.finalUrl, httpStatus: res.status,
      problem: "Link redirects to a different URL",
      suggestedFix: `Update the link to point directly to: ${res.finalUrl}`,
      blocking: false,
      actions: ["auto_fix", "edit", "recheck"],
    };
  }

  return {
    id, type: "internal", status: "passed",
    anchorText, url, finalUrl: res.finalUrl, httpStatus: res.status,
    problem: null, suggestedFix: null, blocking: false, actions: ["recheck"],
  };
}

async function validateExternal(
  id: string,
  anchorText: string,
  url: string,
  minAuthorityScore: number
): Promise<LinkIssue> {
  const domain = getDomain(url);
  const authorityScore = scoreExternalDomain(domain);

  if (authorityScore < minAuthorityScore) {
    return {
      id, type: "external", status: "failed",
      anchorText, url, finalUrl: null, httpStatus: null, authorityScore,
      problem: `Domain "${domain}" scored ${authorityScore} (minimum ${minAuthorityScore}) — low authority source`,
      suggestedFix: "Replace with an official government, regulator, or institution source",
      blocking: true,
      actions: ["find_better_source", "edit", "remove", "recheck"],
    };
  }

  const res = await safeFetch(url);

  if (res.reason === "timeout") {
    return {
      id, type: "external", status: "warning",
      anchorText, url, finalUrl: null, httpStatus: null, authorityScore,
      problem: "Request timed out",
      suggestedFix: "Recheck this link before publishing",
      blocking: false,
      actions: ["recheck", "edit", "remove"],
    };
  }

  if (!res.ok) {
    return {
      id, type: "external", status: "failed",
      anchorText, url, finalUrl: res.finalUrl, httpStatus: res.status, authorityScore,
      problem: `External link returned ${res.status ?? "no response"}`,
      suggestedFix: "Replace with a working authoritative source on the same topic",
      blocking: true,
      actions: ["find_better_source", "edit", "remove", "recheck"],
    };
  }

  // Warn if authority score is above threshold but not strong (40–59)
  if (authorityScore < 60) {
    return {
      id, type: "external", status: "warning",
      anchorText, url, finalUrl: res.finalUrl, httpStatus: res.status, authorityScore,
      problem: `Domain scored ${authorityScore} — acceptable but not a top authority source`,
      suggestedFix: "Consider replacing with a stronger official source if possible",
      blocking: false,
      actions: ["find_better_source", "edit", "recheck"],
    };
  }

  return {
    id, type: "external", status: "passed",
    anchorText, url, finalUrl: res.finalUrl, httpStatus: res.status, authorityScore,
    problem: null, suggestedFix: null, blocking: false, actions: ["recheck"],
  };
}

// ── Main export ────────────────────────────────────────────────

export async function validateLinks(
  links: Array<{ anchor: string; url: string }>,
  config: LinkValidationConfig
): Promise<LinkValidationResult> {
  const issues: LinkIssue[] = [];

  // Validate each link concurrently (capped to avoid hammering servers)
  const BATCH_SIZE = 5;
  let counter = 0;

  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async ({ anchor, url }) => {
        const id = `link_${++counter}`;
        const normalised = normaliseUrl(url, config.siteDomain);

        if (!normalised) {
          return {
            id, type: "internal" as const, status: "skipped" as const,
            anchorText: anchor, url, finalUrl: null, httpStatus: null,
            problem: "URL could not be parsed", suggestedFix: "Check the link format",
            blocking: false, actions: ["edit" as const, "remove" as const],
          } satisfies LinkIssue;
        }

        const domain = getDomain(normalised);
        if (isInternalLink(domain, config.siteDomain)) {
          return validateInternal(id, anchor, normalised);
        } else {
          return validateExternal(id, anchor, normalised, config.minAuthorityScore);
        }
      })
    );

    issues.push(...batchResults);
  }

  // Build summary
  const internals = issues.filter((i) => i.type === "internal");
  const externals = issues.filter((i) => i.type === "external");

  const summarise = (arr: LinkIssue[]): LinkValidationSummary => ({
    passed:  arr.filter((i) => i.status === "passed").length,
    warning: arr.filter((i) => i.status === "warning").length,
    failed:  arr.filter((i) => i.status === "failed").length,
  });

  const hasBlocking = issues.some((i) => i.blocking && i.status === "failed");
  const hasWarnings = issues.some((i) => i.status === "warning");

  const overallStatus: LinkValidationResult["overallStatus"] =
    hasBlocking ? "failed" : hasWarnings ? "warning" : "passed";

  return {
    overallStatus,
    canPublish: !hasBlocking,
    summary: {
      internal: summarise(internals),
      external: summarise(externals),
    },
    issues,
  };
}
