/**
 * app/api/social/captions/route.ts
 * POST /api/social/captions
 *
 * Generates per-platform social captions from a blog post, in Aston's voice,
 * sized to each platform's character budget. Body:
 *   { title, summary, focusKeyword?, link?, targets: SocialTarget[] }
 * Returns { captions: { <platform>: "<text>" } }.
 */

import { NextRequest, NextResponse } from "next/server";
import type { SocialTarget } from "@/lib/social/types";
import { isSocialTarget } from "@/lib/social/registry";
import { generateCaptions } from "@/lib/social/caption";

export const maxDuration = 120;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const {
      title,
      summary,
      focusKeyword,
      link,
      targets,
    }: {
      title: string;
      summary: string;
      focusKeyword?: string;
      link?: string;
      targets: SocialTarget[];
    } = body;

    if (!title?.trim() || !summary?.trim()) {
      return NextResponse.json({ error: "title and summary are required" }, { status: 400 });
    }
    const clean = (Array.isArray(targets) ? targets : []).filter(isSocialTarget);
    if (clean.length === 0) {
      return NextResponse.json({ error: "at least one valid target is required" }, { status: 400 });
    }

    const captions = await generateCaptions({ title, summary, focusKeyword, link }, clean);
    console.log(`[social/captions] generated for ${Object.keys(captions).join(", ") || "none"}`);
    return NextResponse.json({ captions });
  } catch (err: unknown) {
    console.error("[social/captions] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Caption generation failed" },
      { status: 500 }
    );
  }
}
