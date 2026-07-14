/**
 * app/api/cron-social-tokens/route.ts
 * GET /api/cron-social-tokens — invoked daily by Vercel Cron (see vercel.json).
 *
 * Proactively refreshes every stored social OAuth token that is within a week of
 * expiry, so the request-path (inline) refresh almost never has to fire. This is
 * what removes the manual ~60-day env-token rotation for Meta/LinkedIn/TikTok.
 *
 * Vercel Cron passes CRON_SECRET as a Bearer token.
 */

import { NextRequest, NextResponse } from "next/server";
import { refreshAll } from "@/lib/social/tokenRefresh";

export const maxDuration = 60;

function authOk(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results = await refreshAll();
  const refreshed = results.filter((r) => r.refreshed).map((r) => r.platform);
  const errored = results.filter((r) => r.error);
  console.log(
    `[cron-social-tokens] refreshed: ${refreshed.join(", ") || "none"}` +
      (errored.length ? `; errors: ${errored.map((e) => `${e.platform} (${e.error})`).join(", ")}` : "")
  );
  return NextResponse.json({ ok: true, results });
}
