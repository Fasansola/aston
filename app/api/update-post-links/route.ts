/**
 * app/api/update-post-links/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/update-post-links
 *
 * Patches a WordPress post to fix a single link across ALL ACF
 * content fields — called after the user clicks Remove, Edit,
 * or Auto-fix in the link validation panel.
 *
 * Body:
 *   { postId: number, oldUrl: string, action: "replace" | "remove", newUrl?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { patchWordPressPostLinks } from "@/lib/wordpress";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { postId, oldUrl, action, newUrl } = await req.json();

    if (!postId || !oldUrl || !action) {
      return NextResponse.json({ error: "postId, oldUrl and action are required" }, { status: 400 });
    }
    if (action !== "replace" && action !== "remove") {
      return NextResponse.json({ error: "action must be 'replace' or 'remove'" }, { status: 400 });
    }
    if (action === "replace" && !newUrl) {
      return NextResponse.json({ error: "newUrl is required for replace action" }, { status: 400 });
    }

    await patchWordPressPostLinks(postId, oldUrl, action, newUrl);

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error("[update-post-links] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update post" },
      { status: 500 }
    );
  }
}
