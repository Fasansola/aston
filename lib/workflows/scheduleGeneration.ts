/**
 * lib/workflows/scheduleGeneration.ts
 * ─────────────────────────────────────────────────────────────
 * Exact-time generation for queue items.
 *
 * The generation cron only fires once a day (vercel.json), so a queue item
 * scheduled for "+5 minutes" or "+3 hours" cannot ride on it. This workflow
 * gives each time-scheduled item its own durable timer: sleep() until the
 * item is due, then trigger the cron route in targeted mode
 * (GET /api/cron?itemId=…), which runs the exact same generation pipeline,
 * retries and run-logging as a scheduled daily run.
 *
 * The daily cron remains a backstop: getNextEligibleItem() also releases
 * due items, and the targeted route refuses items that are no longer
 * "queued", so the two paths can never double-generate.
 */

import { sleep } from "workflow";

export interface ScheduleGenerationInput {
  itemId: string;
  topic: string;          // for logs only
  scheduledFor: string;   // ISO timestamp the item becomes due
}

function baseUrl(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

async function triggerGenerationStep(itemId: string): Promise<{ status: number; body: string }> {
  "use step";
  console.log(`[scheduleGeneration] Triggering generation for item ${itemId}…`);
  const res = await fetch(`${baseUrl()}/api/cron?itemId=${encodeURIComponent(itemId)}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const body = await res.text().catch(() => "");
  // 409 = item no longer queued (already processed by the daily backstop or
  // deleted) — that is a clean outcome, not an error worth retrying.
  if (!res.ok && res.status !== 409) {
    throw new Error(`targeted cron returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return { status: res.status, body: body.slice(0, 500) };
}

export async function scheduleGenerationWorkflow(input: ScheduleGenerationInput): Promise<void> {
  "use workflow";

  console.log(`[scheduleGeneration] Item ${input.itemId} ("${input.topic}") scheduled for ${input.scheduledFor}`);

  const due = new Date(input.scheduledFor);
  if (due.getTime() > Date.now()) {
    await sleep(due);
  }

  const result = await triggerGenerationStep(input.itemId);
  console.log(`[scheduleGeneration] Item ${input.itemId} trigger finished (HTTP ${result.status})`);
}
