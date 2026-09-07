/**
 * app/api/cron/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/cron            — daily scheduled generation (Vercel Cron)
 * GET /api/cron?itemId=…   — targeted generation for one due queue item
 *                            (invoked by the scheduleGeneration workflow)
 *
 * This route does not run the generation pipeline inline. It only:
 *  1. Recovers items stuck in "processing" (watchdog)
 *  2. Runs a PRE-FLIGHT check (OpenAI credits/key, storage, token budget) so
 *     a generation that cannot possibly succeed fails in seconds with a
 *     plain-English reason instead of after minutes of doomed retries —
 *     the 2026-08-26 → 09-07 "no credits" incident went unnoticed for twelve
 *     days because every run looked like a flaky retry storm
 *  3. Picks eligible queue item(s)
 *  4. STARTS the durable generatePostWorkflow for each and returns, storing
 *     the workflow run id on the item so the watchdog can verify liveness
 *
 * The workflow owns everything else — pipeline steps (checkpointed and
 * auto-retried, resumable after a function kill), queue-item progress and
 * completion/failure bookkeeping, run-log updates, failure notifications,
 * and starting the post-publish media workflow (which always includes
 * images).
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
import { preflight } from "@/lib/health";
import { humaniseError, formatQueueError } from "@/lib/errors";
import type { ImageModel } from "@/lib/openai";

// Starting workflows + Redis bookkeeping + a ~20s pre-flight — the heavy
// pipeline runs in the durable workflow, so this function needs no more.
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
  await updateQueueItem(item.id, {
    status: "processing",
    processingStartedAt: new Date().toISOString(),
    progress: null,
    lastError: null,
    lastErrorDetail: null,
    workflowRunId: null,
  });

  try {
    const run = await start(generatePostWorkflow, [buildWorkflowInput(item, imageModel, runLogId)]);
    console.log(`[cron:${label}] Item ${item.id} ("${item.topic}") → workflow ${run.runId} (log ${runLogId})`);
    // Record the run id so the watchdog can ask the Workflow runtime whether a
    // long-running item is genuinely dead before re-queueing it. Best-effort:
    // a lost write only degrades the watchdog to its time-based heuristic.
    try {
      await updateQueueItem(item.id, { workflowRunId: run.runId });
    } catch (err) {
      console.warn(`[cron:${label}] Could not record workflow run id on item ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, workflowRunId: run.runId, runLogId };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const human = humaniseError(`Could not start generation workflow: ${raw}`);
    console.error(`[cron:${label}] Could not start workflow for item ${item.id}: ${raw}`);
    await updateQueueItem(item.id, {
      status: "failed",
      retryCount: (item.retryCount ?? 0) + 1,
      lastError: formatQueueError(human),
      lastErrorDetail: raw,
      progress: null,
      processingStartedAt: null,
    });
    await updateRunLog(runLogId, { completedAt: new Date().toISOString(), topicsFailed: 1, status: "failed", error: formatQueueError(human) });
    await notify(`❌ Could not start generation for "${item.topic}"`, `${human.title}\n→ ${human.action}\n\nDetails: ${raw}`);
    return { ok: false, error: raw };
  }
}

/**
 * Pre-flight said generation cannot work right now (no OpenAI credits, bad
 * key, storage down, budget reached). Fail the item WITHOUT starting anything
 * so the dashboard shows the real reason immediately. retryCount is not
 * incremented — the item did nothing wrong.
 */
async function failItemPreflight(item: QueueItem, blockers: string): Promise<void> {
  const human = humaniseError(blockers);
  await updateQueueItem(item.id, {
    status: "failed",
    lastError: formatQueueError(human),
    lastErrorDetail: `Pre-flight check failed: ${blockers}`,
    progress: null,
    processingStartedAt: null,
  });
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

  const pre = await preflight();
  if (!pre.ok) {
    await failItemPreflight(item, pre.message);
    await notify(`⛔ Generation blocked for "${item.topic}"`, `${pre.message}\n\nFix the cause, then press Retry now on the dashboard.`);
    // 200, not 5xx: the scheduling workflow must not retry a deliberate stop.
    return NextResponse.json({ started: false, blocked: true, itemId: item.id, reason: pre.message });
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
    if (!(await getNextEligibleItem())) {
      console.log("[cron] No queued items due — nothing to do");
      return NextResponse.json({ skipped: true, reason: "no_items" });
    }

    // Pre-flight once per daily run. If blocked, leave the queue untouched
    // (the items did nothing wrong) and raise ONE alert; they run at the next
    // daily cron once the cause is fixed.
    const pre = await preflight();
    if (!pre.ok) {
      console.error(`[cron] Daily run blocked by pre-flight: ${pre.message}`);
      await notify("⛔ Daily generation skipped", `${pre.message}\n\nQueued topics were left untouched and will run at the next daily cron once this is fixed.`);
      return NextResponse.json({ skipped: true, reason: "preflight_failed", blockers: pre.report.blockers });
    }

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
