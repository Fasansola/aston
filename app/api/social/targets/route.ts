/**
 * app/api/social/targets/route.ts
 * GET /api/social/targets
 * Returns available social targets with connection state + config schema,
 * so the dashboard can render toggles dynamically.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAvailableSocialTargets } from "@/lib/social/registry";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const targets = getAvailableSocialTargets();
  const connected = targets.filter((t) => t.connected).map((t) => t.key);
  console.log(
    `[social/targets] ${targets.length} targets, ${connected.length} connected: ${connected.join(", ") || "none"}`
  );
  return NextResponse.json({ targets });
}
