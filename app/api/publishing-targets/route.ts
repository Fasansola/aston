/**
 * app/api/publishing-targets/route.ts
 * GET /api/publishing-targets
 *
 * Returns available publishing targets with their connection state and
 * config field schema. The frontend uses this to render toggles dynamically.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAvailableTargets } from "@/lib/publishers/registry";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const targets = getAvailableTargets();
  const connected = targets.filter((t) => t.connected).map((t) => t.key);
  console.log(`[publishing-targets] ${targets.length} targets, ${connected.length} connected: ${connected.join(", ") || "none"}`);
  return NextResponse.json({ targets });
}
