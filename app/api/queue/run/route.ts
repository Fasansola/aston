/**
 * app/api/queue/run/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/queue/run  { id }
 *
 * Re-runs a queue item immediately instead of waiting for the daily
 * 08:00 UTC cron. Resets the item to "queued" (clearing any stale
 * error from the previous attempt) and starts the same durable
 * scheduling workflow used for delayed items, with a due time of now —
 * the workflow calls the targeted cron route (GET /api/cron?itemId=…)
 * server-side with CRON_SECRET, so the full generation pipeline,
 * retries and run-logging behave exactly like a scheduled run.
 */

import { NextRequest, NextResponse } from "next/server";
import { getQueueItem, updateQueueItem } from "@/lib/storage";
import { start } from "workflow/api";
import { scheduleGenerationWorkflow } from "@/lib/workflows/scheduleGeneration";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[queue:run] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await req.json();
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const item = await getQueueItem(id);
    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    if (item.status === "processing") {
      return NextResponse.json({ error: "Item is already processing" }, { status: 409 });
    }
    if (item.status === "completed") {
      return NextResponse.json({ error: "Item is already completed" }, { status: 409 });
    }

    // Reset so the targeted cron accepts it and the old failure isn't shown
    // against the new attempt.
    await updateQueueItem(id, { status: "queued", retryCount: 0, lastError: null });

    const scheduledFor = new Date().toISOString();
    const run = await start(scheduleGenerationWorkflow, [
      { itemId: item.id, topic: item.topic, scheduledFor },
    ]);

    console.log(`[queue:run] Item ${id} ("${item.topic}") triggered now (run ${run.runId})`);
    return NextResponse.json({ ok: true, runId: run.runId });
  } catch (err) {
    console.error("[queue:run] Error:", err);
    return NextResponse.json({ error: "Failed to run queue item" }, { status: 500 });
  }
}
