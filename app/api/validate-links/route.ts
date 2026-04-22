/**
 * app/api/validate-links/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/validate-links
 *
 * Accepts a list of links extracted from a generated article,
 * validates each one live, and returns a structured result.
 *
 * Runs on Vercel — link checking can take 15-30s for large articles.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateLinks, LinkValidationConfig } from "@/lib/linkValidator";

export const maxDuration = 45;

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      links,
      siteDomain = "aston.ae",
      minAuthorityScore = 40,
    }: {
      links: Array<{ anchor: string; url: string }>;
      siteDomain?: string;
      minAuthorityScore?: number;
    } = body;

    if (!Array.isArray(links) || links.length === 0) {
      return NextResponse.json({ error: "links array is required" }, { status: 400 });
    }

    const config: LinkValidationConfig = { siteDomain, minAuthorityScore };

    console.log(`[validate-links] Checking ${links.length} links against ${siteDomain}`);
    const result = await validateLinks(links, config);
    console.log(
      `[validate-links] Done. Status: ${result.overallStatus}, ` +
      `internal: ${result.summary.internal.failed} failed / ${result.summary.internal.warning} warn, ` +
      `external: ${result.summary.external.failed} failed / ${result.summary.external.warning} warn`
    );

    return NextResponse.json({ success: true, validation: result });
  } catch (err: unknown) {
    console.error("[validate-links] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Link validation failed" },
      { status: 500 }
    );
  }
}
