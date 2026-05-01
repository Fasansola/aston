/**
 * app/api/auth/route.ts
 *
 * GET  — check if the current session cookie is valid (200 / 401)
 * POST — validate password, set httpOnly session cookie on success
 * DELETE — clear the session cookie (logout)
 */

import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/proxy";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7, // 7 days
};

export function GET(req: NextRequest) {
  const session = req.cookies.get(SESSION_COOKIE)?.value;
  if (session && session === process.env.API_SECRET) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(req: NextRequest) {
  const { password } = await req.json().catch(() => ({ password: "" }));
  if (!password || password !== process.env.API_SECRET) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, process.env.API_SECRET!, COOKIE_OPTIONS);
  return res;
}

export function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
