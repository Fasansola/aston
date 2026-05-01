/**
 * proxy.ts  (Next.js 16 — replaces middleware.ts)
 * ─────────────────────────────────────────────────────────────
 * Protects all /api/* routes with cookie-based session auth.
 *
 * Exempt routes:
 *  - /api/auth          — login / logout (no session yet)
 *  - /api/cron*         — Vercel Cron (authenticated via CRON_SECRET Bearer token)
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "__aston_session";

const EXEMPT_PREFIXES = ["/api/auth", "/api/cron"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
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
