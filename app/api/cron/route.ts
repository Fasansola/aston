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
  getQueueItem,
  updateQueueItem,
  completedTodayCount,
  addRunLog,
  updateRunLog,
} from "@/lib/storage";
import { selectLinks } from "@/lib/links";
import { generateBlueprint, generateBlogContent, fixBlogContent, generateImagePrompts, generateImage, IMAGE_QA_CHECKS, type ImageModel } from "@/lib/openai";
import { uploadImageToWordPress, createWordPressPost, type BlogContent, type ImagePrompts } from "@/lib/wordpress";
import { runQA } from "@/lib/qa";
import { enforceApprovedLinks, scrubBrokenExternalLinks } from "@/lib/linkScrubber";
import { selectAuthorityLinks, mergeWithDiscovered } from "@/lib/authorityLinks";
import { emptyBrief, processSourceInput, SourceBrief } from "@/lib/source";
import { generateStrategy, StrategyBrief, StrategyContext } from "@/lib/strategy";
import { researchTopic, deriveTitle, findExternalAuthorityLinks, ResearchBrief } from "@/lib/research";
import { start } from "workflow/api";
import { generateMediaWorkflow } from "@/lib/workflows/generateMedia";

export const maxDuration = 300;

async function generateImageWithRetry(
  prompt: string,
  model: ImageModel,
  label: string,
  maxAttempts = 2
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateImage(prompt, model);
    } catch (err) {
      lastErr = err;
      console.warn(`[cron:item] Image "${label}" failed (attempt ${attempt}/${maxAttempts}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Image "${label}" failed after ${maxAttempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function authOk(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

async function processOneItem(
  itemId: string,
  topic: string,
  mode: string,
  sourceText: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  strategyInputs?: StrategyContext & { customPrompt?: string },
  imageModel: ImageModel = "gpt-image-2",
  // Per-item media selection (chosen at enqueue time). Items without their
  // own selection fall back to the scheduler-settings defaults.
  media?: { outputs?: { audio: boolean; video: boolean; podcast: boolean }; podcastLength?: number }
) {
  const customInstruction = strategyInputs?.customPrompt?.trim() || undefined;

  // Persist coarse pipeline progress onto the queue item so the admin can show
  // step-by-step status for headless (scheduled) generation. Non-fatal — a
  // failed progress write never interrupts generation.
  const TOTAL_STEPS = 7;
  const reportProgress = async (step: number, label: string) => {
    try {
      await updateQueueItem(itemId, { progress: { step, total: TOTAL_STEPS, label, updatedAt: new Date().toISOString() } });
    } catch (err) {
      console.warn(`[cron:item] progress write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Step 0 — derive title from custom prompt if no topic provided
  let resolvedTopic = topic.trim();
  if (!resolvedTopic && customInstruction) {
    console.log(`[cron:item] No topic — deriving title from custom prompt`);
    const derived = await deriveTitle(customInstruction, strategyInputs?.primary_country);
    resolvedTopic = derived.title;
    console.log(`[cron:item] Derived title: "${resolvedTopic}"`);
  }

  // Step 1 — SEO research
  await reportProgress(1, "Researching the search landscape…");
  let research: ResearchBrief | undefined;
  try {
    research = await researchTopic(resolvedTopic, strategyInputs?.primary_country, customInstruction);
    console.log(`[cron:item] Research ready. Keywords: ${research.dominant_keywords.slice(0, 3).join(", ")}`);
  } catch (err) {
    console.warn("[cron:item] Research step failed — continuing without SERP data:", err);
  }

  // Step 2 — strategy engine
  await reportProgress(2, "Running 12-step strategy analysis…");
  console.log(`[cron:item] Running strategy engine for "${resolvedTopic}"`);
  const strategy: StrategyBrief = await generateStrategy({
    topic:               resolvedTopic,
    audience:            strategyInputs?.audience,
    primary_country:     strategyInputs?.primary_country,
    secondary_countries: strategyInputs?.secondary_countries,
    priority_service:    strategyInputs?.priority_service,
    language:            strategyInputs?.language,
    customPrompt:        customInstruction,
    research,
  });
  console.log(`[cron:item] Strategy ready. Keyword: "${strategy.keyword_model.primary_keyword}", intent: ${strategy.search_intent_type}`);

  let sourceBrief: SourceBrief;
  if (mode === "topic_only" || !sourceText?.trim()) {
    sourceBrief = emptyBrief();
  } else {
    sourceBrief = await processSourceInput(mode as Parameters<typeof processSourceInput>[0], resolvedTopic, sourceText);
  }

  await reportProgress(3, "Planning the article blueprint…");
  const selectedLinks = await selectLinks(resolvedTopic, strategyInputs?.language);
  const blueprint = await generateBlueprint(resolvedTopic, selectedLinks, sourceBrief, strategy, customInstruction, strategyInputs?.language);

  const jurisdictions = (strategy?.jurisdiction_map ?? []).map((j) => j.jurisdiction);
  const curatedLinks = selectAuthorityLinks(`${resolvedTopic} ${strategy?.keyword_model.primary_keyword ?? ""}`, jurisdictions);
  let discoveredLinks: Awaited<ReturnType<typeof findExternalAuthorityLinks>> = [];
  try {
    discoveredLinks = await findExternalAuthorityLinks(
      resolvedTopic,
      strategy?.keyword_model.primary_keyword ?? resolvedTopic,
      jurisdictions
    );
    console.log(`[cron:item] Discovered ${discoveredLinks.length} external authority links`);
  } catch (err) {
    console.warn("[cron:item] External link discovery failed — using curated list only:", err);
  }
  const authorityLinks = mergeWithDiscovered(curatedLinks, discoveredLinks);

  const MAX_ATTEMPTS = 3;
  const fileSlug = resolvedTopic.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);

  type ImageIds = { keypointOneImg: number; keypointTwoImg: number; postSplitImg: number; featuredImg: number };
  let prevContent:      BlogContent | null = null;
  let prevImagePrompts: ImagePrompts | null = null;
  let prevImageIds:     ImageIds | null = null;
  let prevQAChecks:     Record<string, boolean> | null = null;
  let prevBrokenUrls:   string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let content: BlogContent;
    let imagePrompts: ImagePrompts;
    let imageIds: ImageIds;

    if (attempt === 1) {
      await reportProgress(4, "Writing the article…");
      content = await generateBlogContent(resolvedTopic, blueprint, selectedLinks, sourceBrief, strategy, customInstruction, strategyInputs?.language, authorityLinks);
    } else {
      await reportProgress(4, `Revising for quality (attempt ${attempt} of ${MAX_ATTEMPTS})…`);
      const failingFields = Object.entries(prevQAChecks!).filter(([, v]) => !v).map(([k]) => k).join(", ");
      console.log(`[cron:item] QA retry ${attempt}/${MAX_ATTEMPTS} — fixing: ${failingFields}`);
      content = await fixBlogContent(resolvedTopic, prevContent!, blueprint, selectedLinks, prevQAChecks!, strategyInputs?.language, prevBrokenUrls.length > 0 ? prevBrokenUrls : undefined, authorityLinks);
    }

    // ── Pass 1: strip URLs not on an approved domain ─────────────
    const approvedUrls = authorityLinks.map((l) => l.url);
    const { content: enforcedContent, removed: unapproved } = enforceApprovedLinks(content, approvedUrls);
    if (unapproved.length > 0) {
      console.warn(`[cron:item] Removed ${unapproved.length} unapproved external URL(s): ${unapproved.join(", ")}`);
    }
    content = enforcedContent;

    // ── Pass 2: remove genuine 404s only ─────────────────────────
    const { content: scrubbedContent, removed: brokenUrls } = await scrubBrokenExternalLinks(content);
    if (brokenUrls.length > 0) {
      console.warn(`[cron:item] Removed ${brokenUrls.length} 404 external link(s): ${brokenUrls.join(", ")}`);
    }
    content = scrubbedContent;
    prevBrokenUrls = [...unapproved, ...brokenUrls];

    const needNewImages = attempt === 1 || IMAGE_QA_CHECKS.some((k) => !prevQAChecks![k]);
    if (needNewImages) {
      await reportProgress(5, "Generating and uploading images…");
      imagePrompts = await generateImagePrompts(resolvedTopic, content);
      const [kp1Buffer, kp2Buffer, splitBuffer, featuredBuffer] = await Promise.all([
        generateImageWithRetry(imagePrompts.keypoint_one_img_prompt, imageModel, "kp1"),
        generateImageWithRetry(imagePrompts.keypoint_two_img_prompt, imageModel, "kp2"),
        generateImageWithRetry(imagePrompts.post_split_img_prompt,   imageModel, "split"),
        generateImageWithRetry(imagePrompts.featured_img_prompt,     imageModel, "featured"),
      ]);
      const uploadResults = await Promise.allSettled([
        uploadImageToWordPress(kp1Buffer,    `${fileSlug}-kp1.png`,      imagePrompts.keypoint_one_img_alt),
        uploadImageToWordPress(kp2Buffer,    `${fileSlug}-kp2.png`,      imagePrompts.keypoint_two_img_alt),
        uploadImageToWordPress(splitBuffer,  `${fileSlug}-split.png`,    imagePrompts.post_split_img_alt),
        uploadImageToWordPress(featuredBuffer, `${fileSlug}-featured.png`, imagePrompts.featured_img_alt),
      ]);
      const uploadLabels = ["kp1", "kp2", "split", "featured"];
      const uploadErrors = uploadResults
        .map((r, i) => r.status === "rejected" ? `${uploadLabels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : null)
        .filter(Boolean);
      if (uploadErrors.length > 0) throw new Error(`Image upload(s) failed: ${uploadErrors.join("; ")}`);
      const [kp1Media, kp2Media, splitMedia, featuredMedia] = uploadResults.map(
        (r) => (r as PromiseFulfilledResult<{ id: number; url: string }>).value
      );
      imageIds = { keypointOneImg: kp1Media.id, keypointTwoImg: kp2Media.id, postSplitImg: splitMedia.id, featuredImg: featuredMedia.id };
    } else {
      console.log(`[cron:item] Reusing images from attempt 1 — no image QA failures`);
      imagePrompts = prevImagePrompts!;
      imageIds     = prevImageIds!;
    }

    await reportProgress(6, "Running quality checks…");
    const qa = runQA(content, imagePrompts, imageIds, resolvedTopic);
    console.log(`[cron:item] QA attempt ${attempt}: ${qa.status.toUpperCase()} (score ${qa.score}/100)`);

    prevContent      = content;
    prevImagePrompts = imagePrompts;
    prevImageIds     = imageIds;
    prevQAChecks     = qa.checks;

    if (qa.status === "fail") {
      console.warn(`[cron:item] QA FAIL (attempt ${attempt}/${MAX_ATTEMPTS}) — ${qa.blocking_issues.join("; ")}`);
      if (attempt < MAX_ATTEMPTS) continue;
      throw new Error(`QA failed after ${MAX_ATTEMPTS} attempts: ${qa.blocking_issues.join("; ")}`);
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

    await reportProgress(7, "Publishing draft to WordPress…");
    const post = await createWordPressPost(content.seo_title || resolvedTopic, content, imagePrompts, assembled, imageIds, strategyInputs?.language);

    await updateQueueItem(itemId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      progress: null,
      wpPostId: post.id,
      wpEditUrl: `${process.env.WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`,
      wpPostUrl: post.link ?? null,
      qaScore: qa.score,
      qaWarnings: qa.warnings,
      lastError: null,
    });

    // ── Post-publish media outputs (parity with the manual page) ──
    // Fire-and-forget: start() enqueues the durable workflow and returns
    // immediately, so audio/video/podcast generation (up to ~20 min) never
    // presses on this cron invocation's budget. Failures are logged inside
    // the workflow and never affect the completed queue item.
    const mediaOutputs = media?.outputs ?? settings.mediaOutputs;
    if (mediaOutputs && (mediaOutputs.audio || mediaOutputs.video || mediaOutputs.podcast)) {
      try {
        const run = await start(generateMediaWorkflow, [{
          postId: post.id,
          title: content.seo_title || resolvedTopic,
          focusKeyword: content.focus_keyword ?? "",
          secondaryKeywords: content.secondary_keywords ?? [],
          summary: content.meta_description || content.excerpt || "",
          blogUrl: post.link ?? null,
          language: strategyInputs?.language || null,
          content: {
            main_content:   assembled.main_content,
            more_content_1: assembled.more_content_1,
            more_content_2: content.more_content_2,
            more_content_3: assembled.more_content_3,
            more_content_4: assembled.more_content_4,
            more_content_5: content.more_content_5,
            more_content_6: content.more_content_6,
            final_points:   content.final_points,
          },
          outputs: { audio: mediaOutputs.audio, video: mediaOutputs.video, podcast: mediaOutputs.podcast },
          podcastLength: media?.podcastLength ?? settings.podcastLength ?? 30,
        }]);
        console.log(`[cron:item] Media workflow started for post ${post.id} (run ${run.runId}) — audio:${mediaOutputs.audio} video:${mediaOutputs.video} podcast:${mediaOutputs.podcast}`);
      } catch (mediaErr) {
        console.error(`[cron:item] Could not start media workflow for post ${post.id} (non-fatal): ${mediaErr instanceof Error ? mediaErr.message : String(mediaErr)}`);
      }
    }

    return { postId: post.id, qaScore: qa.score };
  }

  throw new Error("Unexpected state after QA retry loop");
}

/**
 * Targeted mode — GET /api/cron?itemId=…
 * Invoked by the scheduleGeneration workflow when a time-scheduled queue item
 * becomes due. Runs the exact same pipeline + retries as a daily run, but for
 * ONE item, bypassing the enabled/daily-quota gates: the user scheduled this
 * item explicitly, so it generates even if the daily scheduler is paused.
 * Refuses items that are not "queued" (409) so the daily backstop and this
 * path can never double-generate.
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
  const runId = `run_scheduled_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`[cron:targeted] Run ${runId} — generating item ${itemId} ("${item.topic}")`);
  await addRunLog({
    runId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    topicsAttempted: 1,
    topicsCompleted: 0,
    topicsFailed: 0,
    status: "running",
  });
  await updateQueueItem(item.id, { status: "processing" });

  const MAX_TECH_RETRIES = 3;
  let lastError = "Unknown error";
  for (let attempt = 1; attempt <= MAX_TECH_RETRIES; attempt++) {
    try {
      const result = await processOneItem(item.id, item.topic, item.mode, item.sourceText, settings, {
        audience:            item.audience,
        primary_country:     item.primary_country,
        secondary_countries: item.secondary_countries,
        priority_service:    item.priority_service,
        language:            item.language,
        customPrompt:        item.customPrompt,
      }, settings.imageModel ?? "gpt-image-2",
      { outputs: item.mediaOutputs, podcastLength: item.podcastLength });
      await updateRunLog(runId, { completedAt: new Date().toISOString(), topicsCompleted: 1, status: "completed" });
      console.log(`[cron:targeted] Item ${item.id} completed — WP post ${result.postId}, QA ${result.qaScore}/100`);
      return NextResponse.json({ runId, itemId: item.id, postId: result.postId, qaScore: result.qaScore });
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown error";
      console.warn(`[cron:targeted] Item ${item.id} attempt ${attempt}/${MAX_TECH_RETRIES} failed: ${lastError}`);
    }
  }

  await updateQueueItem(item.id, { status: "failed", retryCount: (item.retryCount ?? 0) + 1, lastError, progress: null });
  await updateRunLog(runId, { completedAt: new Date().toISOString(), topicsFailed: 1, status: "failed" });
  return NextResponse.json({ error: lastError, itemId: item.id }, { status: 500 });
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[cron] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const targetItemId = req.nextUrl.searchParams.get("itemId");
  if (targetItemId) return processTargetedItem(targetItemId);

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

      const MAX_TECH_RETRIES = 3;
      let itemDone = false;

      for (let techAttempt = 1; techAttempt <= MAX_TECH_RETRIES; techAttempt++) {
        if (techAttempt > 1) {
          console.log(`[cron] Item ${item.id} — technical retry ${techAttempt}/${MAX_TECH_RETRIES}...`);
        }
        try {
          const result = await processOneItem(item.id, item.topic, item.mode, item.sourceText, settings, {
            audience:            item.audience,
            primary_country:     item.primary_country,
            secondary_countries: item.secondary_countries,
            priority_service:    item.priority_service,
            language:            item.language,
            customPrompt:        item.customPrompt,
          }, settings.imageModel ?? "gpt-image-2",
          { outputs: item.mediaOutputs, podcastLength: item.podcastLength });
          run.topicsCompleted++;
          console.log(`[cron] Item ${item.id} completed — WP post ${result.postId}, QA ${result.qaScore}/100`);
          itemDone = true;
          break;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Unknown error";
          if (techAttempt < MAX_TECH_RETRIES) {
            console.warn(`[cron] Item ${item.id} error (attempt ${techAttempt}/${MAX_TECH_RETRIES}), retrying: ${message}`);
          } else {
            console.error(`[cron] Item ${item.id} failed after ${MAX_TECH_RETRIES} attempts: ${message}`);
            const nextRetry = (item.retryCount ?? 0) + 1;
            const maxRetries = settings.maxRetries ?? 2;
            await updateQueueItem(item.id, {
              status: nextRetry <= maxRetries ? "queued" : "failed",
              retryCount: nextRetry,
              lastError: message,
              progress: null,
            });
            run.topicsFailed++;
          }
        }
      }

      if (!itemDone) {
        // already handled above — just ensures the outer loop variable is used
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
