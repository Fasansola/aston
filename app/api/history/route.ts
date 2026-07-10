/**
 * app/api/history/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/history — the 20 most recent generated posts, from BOTH the
 * scheduler and the manual Generate page, newest first. Backs the admin
 * "History" tab, where media can be added to any of them.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPostHistory } from "@/lib/storage";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const posts = await getPostHistory();
    return NextResponse.json({ posts });
  } catch (err) {
    console.error("[history:GET]", err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}
