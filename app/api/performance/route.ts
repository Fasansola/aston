/**
 * app/api/performance/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET  /api/performance          — list all performance records
 * POST /api/performance          — trigger a sync
 *   { action: "sync_all" }       → sync all completed posts
 *   { action: "sync_post", postId: "123" } → sync one post
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GSC_SITE_URL.
 * GA4_PROPERTY_ID is optional — GA4 metrics are skipped if absent.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPerformance } from "@/lib/storage";
import { syncAllPerformance, syncOnePost } from "@/lib/performance";

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const records = await getPerformance();
    console.log(`[performance:GET] ${records.length} records`);
    return NextResponse.json({ records });
  } catch (err) {
    console.error("[performance:GET] Error:", err);
    return NextResponse.json({ error: "Failed to load performance data" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { action, postId } = body;

    if (action === "sync_post") {
      if (!postId) return NextResponse.json({ error: "postId is required" }, { status: 400 });
      console.log(`[performance:POST] Syncing post ${postId}`);
      const record = await syncOnePost(String(postId));
      if (!record) return NextResponse.json({ error: "Post not found or missing URL" }, { status: 404 });
      console.log(`[performance:POST] Synced post ${postId}: ${record.classification} (${record.impressions} impressions)`);
      return NextResponse.json({ record });
    }

    if (action === "sync_all") {
      console.log("[performance:POST] Starting sync_all");
      const result = await syncAllPerformance();
      console.log(`[performance:POST] sync_all done: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`);
      return NextResponse.json({ result });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[performance:POST] Error:", err);
    const message = err instanceof Error ? err.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
