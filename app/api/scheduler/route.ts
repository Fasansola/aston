/**
 * app/api/scheduler/route.ts
 * GET  /api/scheduler — get current settings
 * POST /api/scheduler — update settings
 */

import { NextRequest, NextResponse } from "next/server";
import { getSettings, saveSettings, getRuns, SchedulerSettings } from "@/lib/storage";

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[scheduler:GET] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [settings, runs] = await Promise.all([getSettings(), getRuns(10)]);
    console.log(`[scheduler:GET] enabled=${settings.enabled}, blogsPerDay=${settings.blogsPerDay}`);
    return NextResponse.json({ settings, recentRuns: runs });
  } catch (err) {
    console.error("[scheduler:GET] Error:", err);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[scheduler:POST] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json() as Partial<SchedulerSettings>;

    const current = await getSettings();
    const updated: SchedulerSettings = {
      enabled:      typeof body.enabled === "boolean" ? body.enabled : current.enabled,
      blogsPerDay:  typeof body.blogsPerDay === "number" && body.blogsPerDay >= 1 && body.blogsPerDay <= 20
                      ? body.blogsPerDay : current.blogsPerDay,
      publishMode:  "draft_only",
      maxRetries:   typeof body.maxRetries === "number" && body.maxRetries >= 0 && body.maxRetries <= 5
                      ? body.maxRetries : current.maxRetries,
    };

    await saveSettings(updated);
    console.log(`[scheduler:POST] Settings updated: enabled=${updated.enabled}, blogsPerDay=${updated.blogsPerDay}`);
    return NextResponse.json({ settings: updated });
  } catch (err) {
    console.error("[scheduler:POST] Error:", err);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
