/**
 * app/api/social/comments/route.ts
 * POST /api/social/comments
 *
 * The dashboard comments module. Two actions:
 *   { action: "list",  target, postId, config? } → replies on one of our posts
 *   { action: "reply", target, postId, text, config? } → post a reply from the dashboard
 *
 * postId is the platformPostId returned by /api/social/publish (or a
 * SocialComment.id from a previous "list", to reply to a specific comment).
 */

import { NextRequest, NextResponse } from "next/server";
import type { SocialTarget } from "@/lib/social/types";
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
      action,
      target,
      postId,
      text,
      config = {},
    }: {
      action: "list" | "reply";
      target: SocialTarget;
      postId: string;
      text?: string;
      config?: Record<string, string>;
    } = body;

    if (!isSocialTarget(target)) {
      return NextResponse.json({ error: `unknown target: ${target}` }, { status: 400 });
    }
    if (!postId?.trim()) {
      return NextResponse.json({ error: "postId is required" }, { status: 400 });
    }

    const connector = getSocialConnector(target);

    if (action === "list") {
      const result = await connector.listComments({ target, postId, targetConfig: config });
      console.log(`[social/comments] list ${target} ${postId}: ${result.comments.length} comment(s)`);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    if (action === "reply") {
      if (!text?.trim()) {
        return NextResponse.json({ error: "text is required to reply" }, { status: 400 });
      }
      const result = await connector.reply({ target, postId, text, targetConfig: config });
      console.log(`[social/comments] reply ${target} ${postId}: ${result.status}`);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    return NextResponse.json({ error: "action must be 'list' or 'reply'" }, { status: 400 });
  } catch (err: unknown) {
    console.error("[social/comments] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Comment action failed" },
      { status: 500 }
    );
  }
}
