/**
 * app/api/social/publish/route.ts
 * POST /api/social/publish
 *
 * Cross-posts one SocialPost to one or more social targets. Each target is
 * validated and posted independently — a failure on one does not block others.
 * Mirrors app/api/publish/route.ts, but for the media-first social content model.
 */

import { NextRequest, NextResponse } from "next/server";
import type { SocialTarget, SocialPost, SocialPublishResult } from "@/lib/social/types";
import { getSocialConnector, isSocialTarget } from "@/lib/social/registry";

export const maxDuration = 60;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const {
      post,
      targets,
    }: {
      post: SocialPost;
      /** `text`, when present, overrides post.text for that target (per-platform captions). */
      targets: Array<{ target: SocialTarget; config?: Record<string, string>; text?: string }>;
    } = body;

    if (!post?.text?.trim()) {
      return NextResponse.json({ error: "post.text is required" }, { status: 400 });
    }
    if (!Array.isArray(targets) || targets.length === 0) {
      return NextResponse.json({ error: "at least one target is required" }, { status: 400 });
    }
    const bad = targets.find((t) => !isSocialTarget(t.target));
    if (bad) {
      return NextResponse.json({ error: `unknown target: ${bad.target}` }, { status: 400 });
    }

    console.log(`[social/publish] Posting to ${targets.map((t) => t.target).join(", ")}`);

    const results: SocialPublishResult[] = await Promise.all(
      targets.map(async ({ target, config = {}, text }) => {
        const connector = getSocialConnector(target);
        const validation = await connector.validateConfig(config);
        if (!validation.ok) {
          return {
            target,
            ok: false,
            status: "failed" as const,
            message: validation.errors.join("; "),
          };
        }
        // Per-platform caption override, if the dashboard supplied one.
        const targetPost = text?.trim() ? { ...post, text } : post;
        const result = await connector.publish({ post: targetPost, target, targetConfig: config });
        console.log(
          `[social/publish] ${target}: ${result.status}${result.externalUrl ? ` → ${result.externalUrl}` : ""}`
        );
        return result;
      })
    );

    return NextResponse.json({
      success: results.every((r) => r.ok),
      results,
      summary: {
        passed: results.filter((r) => r.status === "passed").length,
        warning: results.filter((r) => r.status === "warning").length,
        failed: results.filter((r) => r.status === "failed").length,
      },
    });
  } catch (err: unknown) {
    console.error("[social/publish] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Social publishing failed" },
      { status: 500 }
    );
  }
}
