/**
 * app/api/generate/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate
 *
 * Returns a text/event-stream (SSE) response so the client receives
 * real-time status updates during the 3–5 minute pipeline.
 *
 * Event shapes:
 *   { type: "qa_retry",   attempt: N, max: 3 }
 *   { type: "tech_retry", attempt: N, max: 3 }
 *   { type: "done",   success: true, ...result }
 *   { type: "error",  message: string }
 *
 * Validation errors (400/401) are returned as plain JSON before the
 * stream starts so the client can show them immediately.
 */

import { NextRequest, NextResponse } from "next/server";
import { generateBlueprint, generateBlogContent, fixBlogContent, generateImagePrompts, generateImage, IMAGE_QA_CHECKS, type ImageModel } from "@/lib/openai";
import { getSettings } from "@/lib/storage";
import { uploadImageToWordPress, createWordPressPost, type BlogContent, type ImagePrompts } from "@/lib/wordpress";
import { selectLinks } from "@/lib/links";
import { runQA } from "@/lib/qa";
import { enforceApprovedLinks, scrubBrokenExternalLinks } from "@/lib/linkScrubber";
import { selectAuthorityLinks, mergeWithDiscovered } from "@/lib/authorityLinks";
import {
  GenerationMode,
  SourceBrief,
  emptyBrief,
  processSourceInput,
} from "@/lib/source";
import { generateStrategy } from "@/lib/strategy";
import { researchTopic, deriveTitle, findExternalAuthorityLinks, ResearchBrief } from "@/lib/research";

export const maxDuration = 300;

function qa_failing_fields(checks: Record<string, boolean>): string {
  return Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ") || "unknown";
}

/**
 * Generate a single image with up to `maxAttempts` retries.
 * Isolates failures so one bad image doesn't kill the other three.
 */
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
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[generate] Image "${label}" failed (attempt ${attempt}/${maxAttempts}): ${msg}`);
    }
  }
  throw new Error(`Image "${label}" failed after ${maxAttempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function POST(req: NextRequest) {
  // ── 1. Parse + validate (returns JSON, never retried) ────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const {
    topic        = "",
    mode         = "topic_only",
    sourceText   = "",
    audience     = "",
    primary_country     = "",
    secondary_countries = "",
    priority_service    = "",
    language     = "",
    customPrompt = "",
    imageModel: bodyImageModel = "",
  } = body as {
    topic?: string; mode?: GenerationMode;
    sourceText?: string; audience?: string; primary_country?: string;
    secondary_countries?: string; priority_service?: string;
    language?: string; customPrompt?: string; imageModel?: string;
  };

  const hasTopic        = typeof topic === "string" && topic.trim().length >= 5;
  const hasCustomPrompt = typeof customPrompt === "string" && customPrompt.trim().length >= 10;

  if (!hasTopic && !hasCustomPrompt) {
    return NextResponse.json(
      { error: "Please provide a blog topic or a custom prompt (at least 10 characters)." },
      { status: 400 }
    );
  }
  if (!audience?.trim()) {
    return NextResponse.json({ error: "Please provide a target audience." }, { status: 400 });
  }
  const validModes: GenerationMode[] = [
    "topic_only", "source_assisted", "improve_existing", "notes_to_article",
  ];
  if (!validModes.includes(mode as GenerationMode)) {
    return NextResponse.json({ error: "Invalid generation mode." }, { status: 400 });
  }
  if (mode !== "topic_only" && !sourceText?.trim()) {
    return NextResponse.json(
      { error: "Source text is required for this generation mode." },
      { status: 400 }
    );
  }

  const customInstruction = (customPrompt as string).trim() || undefined;
  const settings = await getSettings();
  const imageModel: ImageModel =
    bodyImageModel === "gpt-image-1" ? "gpt-image-1" :
    bodyImageModel === "imagen-4"    ? "imagen-4"    :
    settings.imageModel ?? "imagen-4";

  // ── 2. Open SSE stream ────────────────────────────────────────
  const encoder = new TextEncoder();
  const stream  = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = stream.writable.getWriter();

  const send = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});

  // ── 3. Run pipeline in background ────────────────────────────
  (async () => {
    const MAX_TECH = 3;

    for (let techAttempt = 1; techAttempt <= MAX_TECH; techAttempt++) {

      try {
        // ── Derive title ──────────────────────────────────────
        let title: string;
        let strategyTopic: string;

        if (hasTopic) {
          title = topic.trim();
          strategyTopic = title;
        } else {
          const derived = await deriveTitle(customInstruction!, primary_country || undefined);
          title = derived.title;
          strategyTopic = derived.topic;
          console.log(`[generate] Derived title: "${title}"`);
        }

        // ── SEO research (non-fatal) ──────────────────────────
        let research: ResearchBrief | undefined;
        try {
          research = await researchTopic(title, primary_country || undefined, customInstruction);
        } catch (err) {
          console.warn("[generate] Research step failed — continuing without SERP data:", err);
        }

        // ── Strategy ──────────────────────────────────────────
        const strategy = await generateStrategy({
          topic:               strategyTopic,
          audience:            audience || undefined,
          primary_country:     primary_country || undefined,
          secondary_countries: secondary_countries || undefined,
          priority_service:    priority_service || undefined,
          language:            language || undefined,
          customPrompt:        customInstruction,
          research,
        });
        console.log(`[generate] Strategy ready. Keyword: "${strategy.keyword_model.primary_keyword}"`);

        // ── Source brief ──────────────────────────────────────
        let sourceBrief: SourceBrief;
        if (mode === "topic_only") {
          sourceBrief = emptyBrief();
        } else {
          sourceBrief = await processSourceInput(mode as Parameters<typeof processSourceInput>[0], title, sourceText);
        }

        // ── Links + blueprint (reused across QA retries) ──────
        const selectedLinks = await selectLinks(title, language || undefined);
        const blueprint = await generateBlueprint(title, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined);
        console.log(`[generate] Blueprint ready. Keyword: "${blueprint.focus_keyword}"`);

        // ── Authority links (curated + dynamically discovered) ─
        const jurisdictions = (strategy?.jurisdiction_map ?? []).map((j) => j.jurisdiction);
        const curatedLinks = selectAuthorityLinks(`${title} ${strategy?.keyword_model.primary_keyword ?? ""}`, jurisdictions);
        let discoveredLinks: Awaited<ReturnType<typeof findExternalAuthorityLinks>> = [];
        try {
          discoveredLinks = await findExternalAuthorityLinks(
            title,
            strategy?.keyword_model.primary_keyword ?? title,
            jurisdictions
          );
          console.log(`[generate] Discovered ${discoveredLinks.length} external authority links`);
        } catch (err) {
          console.warn("[generate] External link discovery failed ��� using curated list only:", err);
        }
        const authorityLinks = mergeWithDiscovered(curatedLinks, discoveredLinks);

        // ── QA retry loop ─────────────────────────────────────
        const MAX_QA   = 3;
        const fileSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);

        // State carried across retries so fix passes can build on prior work
        type ImageIds = { keypointOneImg: number; keypointTwoImg: number; postSplitImg: number; featuredImg: number };
        let prevContent:      BlogContent | null = null;
        let prevImagePrompts: ImagePrompts | null = null;
        let prevImageIds:     ImageIds | null = null;
        let prevQAChecks:     Record<string, boolean> | null = null;
        let prevBrokenUrls:   string[] = [];

        for (let qaAttempt = 1; qaAttempt <= MAX_QA; qaAttempt++) {
          let content:      BlogContent;
          let imagePrompts: ImagePrompts;
          let imageIds:     ImageIds;

          if (qaAttempt === 1) {
            // ── Full generation on first attempt ────────────────
            content = await generateBlogContent(
              title, blueprint, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined, authorityLinks
            );
          } else {
            // ── Targeted fix on retries: only rewrite failing fields ─
            await send({ type: "qa_retry", attempt: qaAttempt, max: MAX_QA });
            console.log(`[generate] QA retry ${qaAttempt}/${MAX_QA} — fixing: ${qa_failing_fields(prevQAChecks!)}`);
            content = await fixBlogContent(
              title, prevContent!, blueprint, selectedLinks, prevQAChecks!, language || undefined, prevBrokenUrls.length > 0 ? prevBrokenUrls : undefined, authorityLinks
            );
          }

          // ── Pass 1: strip any URL not in the approved list ────
          const approvedUrls = authorityLinks.map((l) => l.url);
          const { content: enforcedContent, removed: unapproved } = enforceApprovedLinks(content, approvedUrls);
          if (unapproved.length > 0) {
            console.warn(`[generate] Removed ${unapproved.length} unapproved external URL(s): ${unapproved.join(", ")}`);
          }
          content = enforcedContent;

          // ── Pass 2: HEAD-check remaining approved URLs ─────────
          const { content: scrubbedContent, removed: brokenUrls } = await scrubBrokenExternalLinks(content);
          if (brokenUrls.length > 0) {
            console.warn(`[generate] Scrubbed ${brokenUrls.length} broken external link(s): ${brokenUrls.join(", ")}`);
          }
          content = scrubbedContent;
          prevBrokenUrls = [...unapproved, ...brokenUrls];

          // ── Images: regenerate only on attempt 1 or if image checks failed ─
          const needNewImages = qaAttempt === 1 || IMAGE_QA_CHECKS.some((k) => !prevQAChecks![k]);

          if (needNewImages) {
            imagePrompts = await generateImagePrompts(title, content);
            console.log(`[generate] Generating images with ${imageModel}...`);
            const [kp1Buf, kp2Buf, splitBuf, featBuf] = await Promise.all([
              generateImageWithRetry(imagePrompts.keypoint_one_img_prompt, imageModel, "kp1"),
              generateImageWithRetry(imagePrompts.keypoint_two_img_prompt, imageModel, "kp2"),
              generateImageWithRetry(imagePrompts.post_split_img_prompt,   imageModel, "split"),
              generateImageWithRetry(imagePrompts.featured_img_prompt,     imageModel, "featured"),
            ]);
            const uploadResults = await Promise.allSettled([
              uploadImageToWordPress(kp1Buf,   `${fileSlug}-kp1.png`,      imagePrompts.keypoint_one_img_alt),
              uploadImageToWordPress(kp2Buf,   `${fileSlug}-kp2.png`,      imagePrompts.keypoint_two_img_alt),
              uploadImageToWordPress(splitBuf, `${fileSlug}-split.png`,    imagePrompts.post_split_img_alt),
              uploadImageToWordPress(featBuf,  `${fileSlug}-featured.png`, imagePrompts.featured_img_alt),
            ]);
            const uploadLabels = ["kp1", "kp2", "split", "featured"];
            const uploadErrors = uploadResults
              .map((r, i) => r.status === "rejected" ? `${uploadLabels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}` : null)
              .filter(Boolean);
            if (uploadErrors.length > 0) {
              throw new Error(`Image upload(s) failed: ${uploadErrors.join("; ")}`);
            }
            const [kp1, kp2, split, feat] = uploadResults.map(
              (r) => (r as PromiseFulfilledResult<{ id: number; url: string }>).value
            );
            imageIds = { keypointOneImg: kp1.id, keypointTwoImg: kp2.id, postSplitImg: split.id, featuredImg: feat.id };
          } else {
            console.log(`[generate] Reusing images from attempt 1 — no image QA failures`);
            imagePrompts = prevImagePrompts!;
            imageIds     = prevImageIds!;
          }

          const qa = runQA(content, imagePrompts, imageIds, title);
          console.log(`[generate] QA attempt ${qaAttempt}: ${qa.status.toUpperCase()} (${qa.score}/100, ${qa.wordCount} words)`);

          // Persist state for next retry
          prevContent      = content;
          prevImagePrompts = imagePrompts;
          prevImageIds     = imageIds;
          prevQAChecks     = qa.checks;

          if (qa.status === "fail") {
            console.warn(`[generate] QA FAIL (${qaAttempt}/${MAX_QA}) — ${qa.blocking_issues.join("; ")}`);
            if (qaAttempt < MAX_QA) continue;
            await send({ type: "error", message: `Post failed QA after ${MAX_QA} attempts: ${qa.blocking_issues.join("; ")}` });
            return;
          }

          const assembled = {
            main_content:   content.main_content.replace("IMGSLOT_MAIN", ""),
            more_content_1: content.more_content_1.replace("IMGSLOT_ONE", ""),
            more_content_3: content.more_content_3.replace("IMGSLOT_TWO", ""),
            more_content_4: content.more_content_4.replace("IMGSLOT_SPLIT", ""),
          };

          const post = await createWordPressPost(content.seo_title || title, content, imagePrompts, assembled, imageIds, language || undefined);
          console.log(`[generate] Post created! ID: ${post.id}, slug: "${content.slug}"`);

          const articleHtml = [
            content.key_takeaways,
            assembled.main_content,
            content.keypoint_one,
            assembled.more_content_1,
            content.more_content_2,
            content.quote_1,
            assembled.more_content_3,
            content.keypoint_two,
            assembled.more_content_4,
            content.quote_2,
            content.more_content_5,
            content.more_content_6,
            content.final_points,
          ].filter(Boolean).join("\n");

          await send({
            type:        "done",
            success:     true,
            postId:      post.id,
            mode,
            title,
            slug:         content.slug,
            focusKeyword: content.focus_keyword,
            seoTitle:     content.seo_title,
            readMins:     content.read_mins,
            wordCount:    qa.wordCount,
            qaAttempts:   qaAttempt,
            strategy: {
              searchIntentType: strategy.search_intent_type,
              primaryKeyword:   strategy.keyword_model.primary_keyword,
              articleAngle:     strategy.article_angle.slice(0, 200),
            },
            qa: { status: qa.status, score: qa.score, warnings: qa.warnings },
            linksUsed: {
              internal: content.internal_links_used,
              external: content.external_links_used,
            },
            articleHtml,
            excerpt:         content.excerpt,
            metaDescription: content.meta_description,
            tags:            content.secondary_keywords ?? [],
            language:        language || null,
            editUrl:    `${process.env.WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`,
            previewUrl: post.link ?? null,
          });
          return; // success — close stream
        }

        return; // QA loop exhausted (error already sent)

      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (techAttempt < MAX_TECH) {
          console.warn(`[generate] Technical error (attempt ${techAttempt}/${MAX_TECH}), retrying: ${msg}`);
          await send({ type: "tech_retry", attempt: techAttempt + 1, max: MAX_TECH, reason: msg });
        } else {
          console.error(`[generate] All ${MAX_TECH} attempts failed: ${msg}`);
          await send({ type: "error", message: msg || "An unexpected error occurred." });
        }
      }
    }
  })().finally(() => writer.close().catch(() => {}));

  return new Response(stream.readable, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
