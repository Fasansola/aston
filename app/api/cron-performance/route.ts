/**
 * app/api/cron-performance/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/cron-performance — weekly Vercel Cron (every Monday 03:00 UTC)
 * Syncs performance data for all completed posts from GSC + GA4.
 */

import { NextRequest, NextResponse } from "next/server";
import { syncAllPerformance } from "@/lib/performance";

function authOk(req: NextRequest): boolean {
  return (
    req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`
  );
}

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[cron-performance] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[cron-performance] Starting weekly performance sync");

  try {
    const result = await syncAllPerformance();
    console.log(
      `[cron-performance] Done: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`
    );
    if (result.errors.length > 0) {
      console.warn("[cron-performance] Errors:", result.errors.join(" | "));
    }
    return NextResponse.json({ result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[cron-performance] Crashed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
