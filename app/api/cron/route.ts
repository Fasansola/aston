/**
 * app/api/cron/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/cron — invoked by Vercel Cron (see vercel.json)
 *
 * On each run the handler:
 *  1. Checks scheduler is enabled and daily quota not hit
 *  2. Processes up to min(maxPerRun, remaining daily quota) queue items
 *  3. Runs the full blog generation pipeline for each
 *  4. Updates each queue item with result / error
 *  5. Writes a run log entry
 *
 * Vercel Cron passes the CRON_SECRET header automatically.
 * Set CRON_SECRET in your Vercel project env vars.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getSettings,
  getNextEligibleItem,
  updateQueueItem,
  completedTodayCount,
  addRunLog,
  updateRunLog,
} from "@/lib/storage";
import { selectLinks } from "@/lib/links";
import { generateBlueprint, generateBlogContent, generateImagePrompts, generateImage } from "@/lib/openai";
import { uploadImageToWordPress, createWordPressPost } from "@/lib/wordpress";
import { runQA } from "@/lib/qa";
import { emptyBrief, processSourceInput, SourceBrief } from "@/lib/source";
import { generateStrategy, StrategyBrief, StrategyContext } from "@/lib/strategy";

export const maxDuration = 300;

function authOk(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

async function processOneItem(
  itemId: string,
  topic: string,
  mode: string,
  sourceText: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  strategyInputs?: StrategyContext
) {
  // Step 0 — strategy engine
  console.log(`[cron:item] Running strategy engine for "${topic}"`);
  const strategy: StrategyBrief = await generateStrategy({
    topic,
    audience:           strategyInputs?.audience,
    primary_country:    strategyInputs?.primary_country,
    secondary_countries: strategyInputs?.secondary_countries,
    priority_service:   strategyInputs?.priority_service,
    language:           strategyInputs?.language,
  });
  console.log(`[cron:item] Strategy ready. Keyword: "${strategy.keyword_model.primary_keyword}", intent: ${strategy.search_intent_type}`);

  let sourceBrief: SourceBrief;
  if (mode === "topic_only" || !sourceText?.trim()) {
    sourceBrief = emptyBrief();
  } else {
    sourceBrief = await processSourceInput(mode as Parameters<typeof processSourceInput>[0], topic, sourceText);
  }

  const selectedLinks = await selectLinks(topic);
  const blueprint = await generateBlueprint(topic, selectedLinks, sourceBrief, strategy);
  const content = await generateBlogContent(topic, blueprint, selectedLinks, sourceBrief, strategy);
  const imagePrompts = await generateImagePrompts(topic, content);

  const [kp1Buffer, kp2Buffer, splitBuffer, featuredBuffer] = await Promise.all([
    generateImage(imagePrompts.keypoint_one_img_prompt),
    generateImage(imagePrompts.keypoint_two_img_prompt),
    generateImage(imagePrompts.post_split_img_prompt),
    generateImage(imagePrompts.featured_img_prompt),
  ]);

  const fileSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const [kp1Media, kp2Media, splitMedia, featuredMedia] = await Promise.all([
    uploadImageToWordPress(kp1Buffer, `${fileSlug}-kp1.png`, imagePrompts.keypoint_one_img_alt),
    uploadImageToWordPress(kp2Buffer, `${fileSlug}-kp2.png`, imagePrompts.keypoint_two_img_alt),
    uploadImageToWordPress(splitBuffer, `${fileSlug}-split.png`, imagePrompts.post_split_img_alt),
    uploadImageToWordPress(featuredBuffer, `${fileSlug}-featured.png`, imagePrompts.featured_img_alt),
  ]);

  const imageIds = {
    keypointOneImg: kp1Media.id,
    keypointTwoImg: kp2Media.id,
    postSplitImg:   splitMedia.id,
    featuredImg:    featuredMedia.id,
  };

  const qa = runQA(content, imagePrompts, imageIds, topic);
  if (qa.status === "fail") {
    throw new Error(`QA failed: ${qa.blocking_issues.join("; ")}`);
  }

  if (settings.blockOnQaWarning && qa.status === "warn") {
    throw new Error(`QA warnings blocked publish: ${qa.warnings.join("; ")}`);
  }

  const assembled = {
    main_content:   content.main_content.replace("IMGSLOT_MAIN", ""),
    more_content_1: content.more_content_1.replace("IMGSLOT_ONE", ""),
    more_content_3: content.more_content_3.replace("IMGSLOT_TWO", ""),
    more_content_4: content.more_content_4.replace("IMGSLOT_SPLIT", ""),
  };

  const post = await createWordPressPost(topic, content, imagePrompts, assembled, imageIds);

  await updateQueueItem(itemId, {
    status: "completed",
    completedAt: new Date().toISOString(),
    wpPostId: post.id,
    wpEditUrl: `${process.env.WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`,
    wpPostUrl: post.link ?? null,
    qaScore: qa.score,
    qaWarnings: qa.warnings,
    lastError: null,
  });

  return { postId: post.id, qaScore: qa.score };
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[cron] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`[cron] Run ${runId} started`);

  const run = {
    runId,
    startedAt: new Date().toISOString(),
    completedAt: null as string | null,
    topicsAttempted: 0,
    topicsCompleted: 0,
    topicsFailed: 0,
    status: "running" as const,
  };
  await addRunLog(run);

  try {
    // ── 1. Check scheduler settings ──────────────────────
    const settings = await getSettings();
    if (!settings.enabled) {
      console.log("[cron] Scheduler is disabled — skipping");
      await updateRunLog(runId, { completedAt: new Date().toISOString(), status: "completed" });
      return NextResponse.json({ skipped: true, reason: "scheduler_disabled" });
    }

    const doneToday = await completedTodayCount();
    if (doneToday >= settings.blogsPerDay) {
      console.log(`[cron] Daily quota reached (${doneToday}/${settings.blogsPerDay}) — skipping`);
      await updateRunLog(runId, { completedAt: new Date().toISOString(), status: "completed" });
      return NextResponse.json({ skipped: true, reason: "daily_quota_reached", doneToday });
    }

    // ── 2. Process items up to min(maxPerRun, remaining quota) ──
    const maxPerRun   = settings.maxPerRun ?? 1;
    const remaining   = settings.blogsPerDay - doneToday;
    const limit       = Math.min(maxPerRun, remaining);

    console.log(`[cron] Will process up to ${limit} item(s) this run (${doneToday}/${settings.blogsPerDay} done today)`);

    for (let i = 0; i < limit; i++) {
      const item = await getNextEligibleItem();
      if (!item) {
        console.log("[cron] No more queued items");
        break;
      }

      console.log(`[cron] Processing item ${item.id}: "${item.topic}" (${i + 1}/${limit})`);
      await updateQueueItem(item.id, { status: "processing" });
      run.topicsAttempted++;

      try {
        const result = await processOneItem(item.id, item.topic, item.mode, item.sourceText, settings, {
          audience:           item.audience,
          primary_country:    item.primary_country,
          secondary_countries: item.secondary_countries,
          priority_service:   item.priority_service,
          language:           item.language,
        });
        run.topicsCompleted++;
        console.log(`[cron] Item ${item.id} completed — WP post ${result.postId}, QA ${result.qaScore}/100`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[cron] Item ${item.id} failed: ${message}`);

        const nextRetry = (item.retryCount ?? 0) + 1;
        const maxRetries = settings.maxRetries ?? 2;
        await updateQueueItem(item.id, {
          status: nextRetry <= maxRetries ? "queued" : "failed",
          retryCount: nextRetry,
          lastError: message,
        });
        run.topicsFailed++;
      }
    }

    // ── 3. Write final run log ────────────────────────────
    const finalStatus = run.topicsFailed > 0 ? "completed_with_errors" : "completed";
    await updateRunLog(runId, {
      completedAt: new Date().toISOString(),
      topicsAttempted: run.topicsAttempted,
      topicsCompleted: run.topicsCompleted,
      topicsFailed: run.topicsFailed,
      status: finalStatus,
    });

    console.log(`[cron] Run ${runId} finished: ${finalStatus} (${run.topicsCompleted} completed, ${run.topicsFailed} failed)`);
    return NextResponse.json({
      runId,
      status: finalStatus,
      topicsAttempted: run.topicsAttempted,
      topicsCompleted: run.topicsCompleted,
      topicsFailed: run.topicsFailed,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[cron] Run ${runId} crashed: ${message}`);
    await updateRunLog(runId, { completedAt: new Date().toISOString(), status: "failed" });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
