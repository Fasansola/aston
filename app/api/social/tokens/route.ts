/**
 * app/api/social/tokens/route.ts
 * Admin API for the social OAuth token store.
 *
 *   GET    — token status per platform (source, expiry, refresh health)
 *   POST   — seed/overwrite a platform token (from an OAuth flow / Graph Explorer),
 *            or { action: "refresh" } to force a refresh pass now
 *   DELETE — clear a platform's stored token (falls back to env)
 *
 * The initial access token is obtained out of band (each platform's OAuth
 * consent / token endpoint) and seeded here once; the refresher then keeps it
 * alive, removing the manual ~60-day env rotation.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getTokenStatuses,
  setTokenFromGrant,
  deleteToken,
  STORED_PLATFORMS,
} from "@/lib/social/tokenStore";
import { refreshAll } from "@/lib/social/tokenRefresh";
import type { SocialTarget } from "@/lib/social/types";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

function isStored(p: unknown): p is SocialTarget {
  return typeof p === "string" && (STORED_PLATFORMS as string[]).includes(p);
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ statuses: await getTokenStatuses() });
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.action === "refresh") {
    return NextResponse.json({ ok: true, results: await refreshAll() });
  }

  const platform = body.platform;
  if (!isStored(platform)) {
    return NextResponse.json(
      { error: `platform must be one of: ${STORED_PLATFORMS.join(", ")}` },
      { status: 400 }
    );
  }
  if (typeof body.accessToken !== "string" || !body.accessToken) {
    return NextResponse.json({ error: "accessToken is required" }, { status: 400 });
  }

  const record = await setTokenFromGrant(platform, {
    accessToken: body.accessToken,
    refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : undefined,
    expiresInSeconds: typeof body.expiresInSeconds === "number" ? body.expiresInSeconds : undefined,
    refreshTokenExpiresInSeconds:
      typeof body.refreshTokenExpiresInSeconds === "number" ? body.refreshTokenExpiresInSeconds : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  });
  console.log(`[social/tokens] seeded ${platform}; expiresAt=${record.expiresAt ?? "none"}`);
  return NextResponse.json({ ok: true, platform, expiresAt: record.expiresAt });
}

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const platform = new URL(req.url).searchParams.get("platform");
  if (!isStored(platform)) {
    return NextResponse.json(
      { error: `platform must be one of: ${STORED_PLATFORMS.join(", ")}` },
      { status: 400 }
    );
  }
  await deleteToken(platform);
  return NextResponse.json({ ok: true, platform });
}
