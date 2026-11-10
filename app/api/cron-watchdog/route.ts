/**
 * app/api/cron-watchdog/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/cron-watchdog — every 30 minutes (vercel.json)
 *
 * Recovers queue items pinned in "processing" by a killed run WITHOUT
 * depending on anyone opening the dashboard (the queue-GET watchdog) or on
 * the once-daily generation cron. Sends a notification when it recovers
 * anything, so silent overnight failures surface within half an hour.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSettings, getQueue, recoverStuckProcessingItems, compactQueueIfIdle } from "@/lib/storage";
import { notify } from "@/lib/notify";

export const maxDuration = 30;

function authOk(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { maxRetries } = await getSettings();
    const queue = await getQueue();
    const recovered = await recoverStuckProcessingItems(maxRetries ?? 2, queue);

    // One-time shrink of completed items' briefs written before saveQueue
    // started compacting (a no-op once done, and skipped while a run is
    // processing so it can never race the run's own status write).
    const compacted = recovered === 0 && await compactQueueIfIdle(queue);
    if (compacted) console.log("[watchdog] Dropped stored briefs from completed queue items");

    if (recovered > 0) {
      // Report what the recovery decided (`queue` was updated in place):
      // re-queued items retry on the next cron; exhausted ones are failed and
      // need a manual "Retry now".
      const failed = queue.filter((i) => i.status === "failed").length;
      const queued = queue.filter((i) => i.status === "queued").length;
      console.warn(`[watchdog] Recovered ${recovered} stuck item(s) — queue now: ${queued} queued, ${failed} failed`);
      await notify(
        `⚠️ Watchdog recovered ${recovered} stuck generation(s)`,
        `A run was interrupted (function killed or timed out). Queue now: ${queued} queued, ${failed} failed. Check the dashboard.`
      );
    }

    return NextResponse.json({ recovered, compacted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[watchdog] Failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
