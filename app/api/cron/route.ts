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
import { generateBlueprint, generateBlogContent, fixBlogContent, generateImagePrompts, generateImage, IMAGE_QA_CHECKS, type ImageModel } from "@/lib/openai";
import { uploadImageToWordPress, createWordPressPost, type BlogContent, type ImagePrompts } from "@/lib/wordpress";
import { runQA } from "@/lib/qa";
import { enforceApprovedLinks, scrubBrokenExternalLinks } from "@/lib/linkScrubber";
import { selectAuthorityLinks, mergeWithDiscovered } from "@/lib/authorityLinks";
import { emptyBrief, processSourceInput, SourceBrief } from "@/lib/source";
import { generateStrategy, StrategyBrief, StrategyContext } from "@/lib/strategy";
import { researchTopic, deriveTitle, findExternalAuthorityLinks, ResearchBrief } from "@/lib/research";

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
  imageModel: ImageModel = "imagen-4"
) {
  const customInstruction = strategyInputs?.customPrompt?.trim() || undefined;

  // Step 0 — derive title from custom prompt if no topic provided
  let resolvedTopic = topic.trim();
  if (!resolvedTopic && customInstruction) {
    console.log(`[cron:item] No topic — deriving title from custom prompt`);
    const derived = await deriveTitle(customInstruction, strategyInputs?.primary_country);
    resolvedTopic = derived.title;
    console.log(`[cron:item] Derived title: "${resolvedTopic}"`);
  }

  // Step 1 — SEO research
  let research: ResearchBrief | undefined;
  try {
    research = await researchTopic(resolvedTopic, strategyInputs?.primary_country, customInstruction);
    console.log(`[cron:item] Research ready. Keywords: ${research.dominant_keywords.slice(0, 3).join(", ")}`);
  } catch (err) {
    console.warn("[cron:item] Research step failed — continuing without SERP data:", err);
  }

  // Step 2 — strategy engine
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
      content = await generateBlogContent(resolvedTopic, blueprint, selectedLinks, sourceBrief, strategy, customInstruction, strategyInputs?.language, authorityLinks);
    } else {
      const failingFields = Object.entries(prevQAChecks!).filter(([, v]) => !v).map(([k]) => k).join(", ");
      console.log(`[cron:item] QA retry ${attempt}/${MAX_ATTEMPTS} — fixing: ${failingFields}`);
      content = await fixBlogContent(resolvedTopic, prevContent!, blueprint, selectedLinks, prevQAChecks!, strategyInputs?.language, prevBrokenUrls.length > 0 ? prevBrokenUrls : undefined, authorityLinks);
    }

    // ── Pass 1: strip any URL not in the approved list ──────────
    const approvedUrls = authorityLinks.map((l) => l.url);
    const { content: enforcedContent, removed: unapproved } = enforceApprovedLinks(content, approvedUrls);
    if (unapproved.length > 0) {
      console.warn(`[cron:item] Removed ${unapproved.length} unapproved external URL(s): ${unapproved.join(", ")}`);
    }
    content = enforcedContent;

    // ── Pass 2: HEAD-check remaining approved URLs ─────────────
    const { content: scrubbedContent, removed: brokenUrls } = await scrubBrokenExternalLinks(content);
    if (brokenUrls.length > 0) {
      console.warn(`[cron:item] Scrubbed ${brokenUrls.length} broken external link(s): ${brokenUrls.join(", ")}`);
    }
    content = scrubbedContent;
    prevBrokenUrls = [...unapproved, ...brokenUrls];

    const needNewImages = attempt === 1 || IMAGE_QA_CHECKS.some((k) => !prevQAChecks![k]);
    if (needNewImages) {
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

    const post = await createWordPressPost(content.seo_title || resolvedTopic, content, imagePrompts, assembled, imageIds, strategyInputs?.language);

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

  throw new Error("Unexpected state after QA retry loop");
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
          }, settings.imageModel ?? "imagen-4");
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
