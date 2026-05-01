/**
 * app/api/publish/route.ts
 * POST /api/publish
 *
 * Dispatches a generated article to one or more publishing targets.
 * Each target is validated and published independently — a failure on
 * one target does not block others unless requireAllPass is true.
 */

import { NextRequest, NextResponse } from "next/server";
import type { PublishTarget, PublishRequest, PublishResult } from "@/lib/publishers/types";
import { getConnector } from "@/lib/publishers/registry";
import { htmlToMarkdown } from "@/lib/publishers/htmlToMarkdown";

export const maxDuration = 60;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      title,
      excerpt = "",
      html,
      tags = [],
      seoTitle,
      seoDescription,
      featuredImageUrl,
      canonicalUrl,
      targets,
      requireAllPass = false,
    }: {
      title: string;
      excerpt?: string;
      html: string;
      tags?: string[];
      seoTitle?: string;
      seoDescription?: string;
      featuredImageUrl?: string;
      canonicalUrl?: string;
      targets: Array<{ target: PublishTarget; config: Record<string, string> }>;
      requireAllPass?: boolean;
    } = body;

    if (!title?.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (!html?.trim()) {
      return NextResponse.json({ error: "html is required" }, { status: 400 });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return NextResponse.json({ error: "at least one target is required" }, { status: 400 });
    }

    const markdown = htmlToMarkdown(html);

    console.log(`[publish] Dispatching "${title}" to ${targets.map((t) => t.target).join(", ")}`);

    // Validate all target configs first
    const validationErrors: Array<{ target: PublishTarget; errors: string[] }> = [];
    await Promise.all(
      targets.map(async ({ target, config }) => {
        const connector = getConnector(target);
        const result = await connector.validateConfig(config);
        if (!result.ok) validationErrors.push({ target, errors: result.errors });
      })
    );

    if (validationErrors.length > 0 && requireAllPass) {
      return NextResponse.json(
        { error: "One or more targets failed config validation", validationErrors },
        { status: 422 }
      );
    }

    // Publish to each target (skipping config-invalid ones if not requireAllPass)
    const invalidTargets = new Set(validationErrors.map((e) => e.target));

    const results: PublishResult[] = await Promise.all(
      targets.map(async ({ target, config }) => {
        if (invalidTargets.has(target)) {
          const errs = validationErrors.find((e) => e.target === target)?.errors ?? [];
          return {
            target,
            ok: false,
            status: "failed" as const,
            message: errs.join("; "),
          };
        }

        const request: PublishRequest = {
          title,
          excerpt,
          html,
          markdown,
          tags,
          seoTitle,
          seoDescription,
          featuredImageUrl,
          canonicalUrl,
          target,
          targetConfig: config,
        };

        const connector = getConnector(target);
        const result = await connector.publish(request);

        console.log(
          `[publish] ${target}: ${result.status}${result.externalUrl ? ` → ${result.externalUrl}` : ""}`
        );

        return result;
      })
    );

    const allPassed = results.every((r) => r.ok);
    const anyFailed = results.some((r) => !r.ok);

    return NextResponse.json({
      success: allPassed || (!requireAllPass && !anyFailed),
      results,
      summary: {
        passed:  results.filter((r) => r.status === "passed").length,
        warning: results.filter((r) => r.status === "warning").length,
        failed:  results.filter((r) => r.status === "failed").length,
      },
    });
  } catch (err: unknown) {
    console.error("[publish] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Publishing failed" },
      { status: 500 }
    );
  }
}
