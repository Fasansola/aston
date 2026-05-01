/**
 * app/api/validate-readiness/route.ts
 * POST /api/validate-readiness
 *
 * Runs the Search & AI Readiness Validator and returns a composite
 * 0-100 score across 5 weighted categories.
 */

import { NextRequest, NextResponse } from "next/server";
import { runReadinessValidator, type ReadinessInput } from "@/lib/readinessValidator";

export const maxDuration = 30;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const input: ReadinessInput = {
      title:                   body.title,
      seoTitle:                body.seoTitle,
      metaDescription:         body.metaDescription ?? "",
      slug:                    body.slug,
      focusKeyword:            body.focusKeyword,
      articleHtml:             body.articleHtml,
      wordCount:               Number(body.wordCount) || 0,
      language:                body.language ?? null,
      internalLinksCount:      Number(body.internalLinksCount) || 0,
      externalLinksCount:      Number(body.externalLinksCount) || 0,
      hasLinkValidationFailures: body.hasLinkValidationFailures ?? false,
      qaWarnings:              body.qaWarnings ?? [],
      qaChecks:                body.qaChecks ?? {},
    };

    if (!input.title?.trim() || !input.articleHtml?.trim()) {
      return NextResponse.json(
        { error: "title and articleHtml are required" },
        { status: 400 }
      );
    }

    const result = runReadinessValidator(input);
    return NextResponse.json({ result });
  } catch (err: unknown) {
    console.error("[validate-readiness] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Validation failed" },
      { status: 500 }
    );
  }
}
