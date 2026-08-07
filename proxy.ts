/**
 * proxy.ts  (Next.js 16 — replaces middleware.ts)
 * ─────────────────────────────────────────────────────────────
 * Protects all /api/* routes with cookie-based session auth.
 *
 * Exempt routes:
 *  - /api/auth          — login / logout (no session yet)
 *  - /api/cron*         — Vercel Cron (authenticated via CRON_SECRET Bearer token)
 *  - /api/podcast       — public podcast RSS feed (Spotify's crawler has no cookie)
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "__aston_session";

const EXEMPT_PREFIXES = ["/api/auth", "/api/cron", "/api/podcast"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Vercel Cron sends no cookie — a valid CRON_SECRET bearer is equivalent
  // trust. Lets crons target routes outside /api/cron* (e.g. the daily
  // /api/links/sync-wp refresh); each such route re-checks the bearer itself.
  if (
    process.env.CRON_SECRET &&
    req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.next();
  }

  const session = req.cookies.get(SESSION_COOKIE)?.value;
  if (!session || session !== process.env.API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
