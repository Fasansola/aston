/**
 * app/api/health/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET  /api/health            — full system status (dashboard "System status" card)
 * GET  /api/health?quick=1    — skip the OpenAI ping (cheaper, faster)
 * POST /api/health            — { action: "test-alert" } sends a test notification
 *
 * Session-protected by proxy.ts (a CRON_SECRET bearer also passes).
 */

import { NextRequest, NextResponse } from "next/server";
import { runHealthReport, checkAlerts } from "@/lib/health";
import { notify } from "@/lib/notify";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const quick = req.nextUrl.searchParams.get("quick") === "1";
  try {
    const report = await runHealthReport({ skipOpenAI: quick });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  if (body.action !== "test-alert") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  const alerts = checkAlerts();
  if (alerts.status !== "ok") {
    return NextResponse.json({ ok: false, sent: false, message: alerts.message, hint: alerts.hint });
  }
  await notify("✅ Test alert from the Aston blog tool", `Sent ${new Date().toISOString()}. Failure alerts will arrive on this channel.`);
  return NextResponse.json({ ok: true, sent: true, message: `Test alert sent (${alerts.message})` });
}
