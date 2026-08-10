/**
 * app/api/cron/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/cron            — daily scheduled generation (Vercel Cron)
 * GET /api/cron?itemId=…   — targeted generation for one due queue item
 *                            (invoked by the scheduleGeneration workflow)
 *
 * This route no longer runs the generation pipeline inline. It only:
 *  1. Recovers items stuck in "processing" (watchdog)
 *  2. Picks eligible queue item(s)
 *  3. STARTS the durable generatePostWorkflow for each and returns
 *
 * The workflow owns everything else — pipeline steps (checkpointed and
 * auto-retried, resumable after a function kill), queue-item progress and
 * completion/failure bookkeeping, run-log updates, failure notifications,
 * and starting the post-publish media workflow (which always includes
 * images). A killed function therefore no longer loses work: the run
 * resumes from its last completed step instead of restarting from zero.
 *
 * Vercel Cron passes the CRON_SECRET header automatically.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getSettings,
  getNextEligibleItem,
  getQueueItem,
  updateQueueItem,
  completedTodayCount,
  addRunLog,
  updateRunLog,
  recoverStuckProcessingItems,
  type QueueItem,
} from "@/lib/storage";
import { start } from "workflow/api";
import { generatePostWorkflow, type GeneratePostInput } from "@/lib/workflows/generatePost";
import { notify } from "@/lib/notify";
import type { ImageModel } from "@/lib/openai";

// Starting workflows + Redis bookkeeping only — the heavy pipeline runs in
// the durable workflow, so this function needs none of its old 800s budget.
export const maxDuration = 60;

function authOk(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

function buildWorkflowInput(
  item: QueueItem,
  imageModel: ImageModel,
  runLogId: string
): GeneratePostInput {
  return {
    hasTopic: !!item.topic?.trim(),
    title: item.topic?.trim() ?? "",
    mode: item.mode,
    sourceText: item.sourceText ?? "",
    audience: item.audience ?? "",
    primary_country: item.primary_country ?? "",
    secondary_countries: item.secondary_countries ?? "",
    priority_service: item.priority_service ?? "",
    language: item.language ?? "",
    customInstruction: item.customPrompt?.trim() || undefined,
    imageModel,
    queueItemId: item.id,
    runLogId,
    mediaOutputs: item.mediaOutputs,
    podcastLength: item.podcastLength,
  };
}

/** Mark the item processing, write a run log, start the durable workflow. */
async function launchItem(
  item: QueueItem,
  imageModel: ImageModel,
  label: "targeted" | "daily"
): Promise<{ ok: true; workflowRunId: string; runLogId: string } | { ok: false; error: string }> {
  const runLogId = `run_scheduled_${new Date().toISOString().replace(/[:.]/g, "-")}_${item.id.slice(-6)}`;
  await addRunLog({
    runId: runLogId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    topicsAttempted: 1,
    topicsCompleted: 0,
    topicsFailed: 0,
    status: "running",
  });
  await updateQueueItem(item.id, { status: "processing", processingStartedAt: new Date().toISOString(), progress: null });

  try {
    const run = await start(generatePostWorkflow, [buildWorkflowInput(item, imageModel, runLogId)]);
    console.log(`[cron:${label}] Item ${item.id} ("${item.topic}") → workflow ${run.runId} (log ${runLogId})`);
    return { ok: true, workflowRunId: run.runId, runLogId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron:${label}] Could not start workflow for item ${item.id}: ${msg}`);
    await updateQueueItem(item.id, {
      status: "failed",
      retryCount: (item.retryCount ?? 0) + 1,
      lastError: `Could not start generation workflow: ${msg}`,
      progress: null,
    });
    await updateRunLog(runLogId, { completedAt: new Date().toISOString(), topicsFailed: 1, status: "failed" });
    await notify(`❌ Could not start generation for "${item.topic}"`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Targeted mode — GET /api/cron?itemId=…
 * Refuses items that are not "queued" (409) so the daily backstop and the
 * per-item timers can never double-generate. Returns 202 as soon as the
 * durable workflow is started; progress lands on the queue item.
 */
async function processTargetedItem(itemId: string) {
  const item = await getQueueItem(itemId);
  if (!item) {
    return NextResponse.json({ error: `Queue item ${itemId} not found` }, { status: 404 });
  }
  if (item.status !== "queued") {
    console.log(`[cron:targeted] Item ${itemId} is "${item.status}" — nothing to do`);
    return NextResponse.json({ skipped: true, reason: `item_${item.status}` }, { status: 409 });
  }

  const settings = await getSettings();
  const launched = await launchItem(item, settings.imageModel ?? "gpt-image-2", "targeted");
  if (!launched.ok) {
    return NextResponse.json({ error: launched.error, itemId: item.id }, { status: 500 });
  }
  return NextResponse.json(
    { started: true, itemId: item.id, workflowRunId: launched.workflowRunId, runId: launched.runLogId },
    { status: 202 }
  );
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[cron] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Watchdog: re-queue any item pinned in "processing" by a killed run. Also
  // runs from /api/cron-watchdog every 30 minutes; kept here as well so a
  // targeted/daily pass never trips over a stale item.
  try {
    const { maxRetries } = await getSettings();
    const recovered = await recoverStuckProcessingItems(maxRetries ?? 2);
    if (recovered > 0) console.warn(`[cron] Watchdog re-queued ${recovered} stuck item(s)`);
  } catch (err) {
    console.warn(`[cron] Watchdog check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  const targetItemId = req.nextUrl.searchParams.get("itemId");
  if (targetItemId) return processTargetedItem(targetItemId);

  // ── Daily mode: start workflows for eligible items up to the quota ──
  console.log("[cron] Daily run started");
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      console.log("[cron] Scheduler is disabled — skipping");
      return NextResponse.json({ skipped: true, reason: "scheduler_disabled" });
    }

    const doneToday = await completedTodayCount();
    if (doneToday >= settings.blogsPerDay) {
      console.log(`[cron] Daily quota reached (${doneToday}/${settings.blogsPerDay}) — skipping`);
      return NextResponse.json({ skipped: true, reason: "daily_quota_reached", doneToday });
    }

    const limit = Math.min(settings.maxPerRun ?? 1, settings.blogsPerDay - doneToday);
    console.log(`[cron] Starting up to ${limit} workflow(s) (${doneToday}/${settings.blogsPerDay} done today)`);

    const started: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < limit; i++) {
      const item = await getNextEligibleItem();
      if (!item) {
        console.log("[cron] No more queued items");
        break;
      }
      const launched = await launchItem(item, settings.imageModel ?? "gpt-image-2", "daily");
      (launched.ok ? started : failed).push(item.id);
    }

    console.log(`[cron] Daily run finished — ${started.length} workflow(s) started, ${failed.length} failed to start`);
    return NextResponse.json({ started, failedToStart: failed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[cron] Daily run crashed: ${message}`);
    await notify("❌ Daily generation cron crashed", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
