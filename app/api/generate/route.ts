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
import { generateBlueprint, generateBlogContent, fixBlogContent, generateImagePrompts, IMAGE_QA_CHECKS, type ImageModel } from "@/lib/openai";
import { getSettings } from "@/lib/storage";
import { createWordPressPost, type BlogContent, type ImagePrompts } from "@/lib/wordpress";
import { selectLinks } from "@/lib/links";
import { runQA, RETRYABLE_WARNING_CHECKS } from "@/lib/qa";
import { enforceApprovedLinks, scrubBrokenExternalLinks, stripLinksFromVisualBlocks } from "@/lib/linkScrubber";
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
    bodyImageModel === "gpt-image-2" ? "gpt-image-2" :
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

    // ── One-time setup (not retried) ─────────────────────────
    // These steps are deterministic given the same inputs; repeating them on
    // every tech retry wastes ~60-100 s of the 300 s Vercel wall-time budget.
    let title: string;
    let strategyTopic: string;
    let strategy: Awaited<ReturnType<typeof generateStrategy>>;
    let sourceBrief: SourceBrief;
    let selectedLinks: Awaited<ReturnType<typeof selectLinks>>;
    let blueprint: Awaited<ReturnType<typeof generateBlueprint>>;
    let authorityLinks: Awaited<ReturnType<typeof mergeWithDiscovered>>;
    let fileSlug: string;

    try {
      if (hasTopic) {
        title = topic.trim();
        strategyTopic = title;
      } else {
        const derived = await deriveTitle(customInstruction!, primary_country || undefined);
        title = derived.title;
        strategyTopic = derived.topic;
        console.log(`[generate] Derived title: "${title}"`);
      }

      // ── Phase 1 (parallel): research + link pool + source brief ──
      // None of these depend on each other; running them concurrently
      // saves the sequential cost of whichever two finish first (~30s).
      let research: ResearchBrief | undefined;
      [research, selectedLinks, sourceBrief] = await Promise.all([
        researchTopic(title, primary_country || undefined, customInstruction).catch((err) => {
          console.warn("[generate] Research step failed — continuing without SERP data:", err);
          return undefined;
        }),
        selectLinks(title, language || undefined),
        mode === "topic_only"
          ? Promise.resolve(emptyBrief())
          : processSourceInput(mode as Parameters<typeof processSourceInput>[0], title, sourceText),
      ]);

      // ── Strategy (needs research result) ─────────────────────────
      strategy = await generateStrategy({
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

      // ── Phase 2 (parallel): blueprint + authority link discovery ──
      // generateBlueprint needs selectedLinks + strategy + sourceBrief (all ready).
      // findExternalAuthorityLinks needs strategy keywords (just computed).
      const jurisdictions = (strategy?.jurisdiction_map ?? []).map((j) => j.jurisdiction);
      const curatedLinks = selectAuthorityLinks(`${title} ${strategy?.keyword_model.primary_keyword ?? ""}`, jurisdictions);
      let discoveredLinks: Awaited<ReturnType<typeof findExternalAuthorityLinks>> = [];

      [blueprint, discoveredLinks] = await Promise.all([
        generateBlueprint(title, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined),
        findExternalAuthorityLinks(
          title,
          strategy?.keyword_model.primary_keyword ?? title,
          jurisdictions
        ).catch((err) => {
          console.warn("[generate] External link discovery failed — using curated list only:", err);
          return [];
        }),
      ]);
      console.log(`[generate] Blueprint ready. Keyword: "${blueprint.focus_keyword}"`);
      console.log(`[generate] Discovered ${discoveredLinks.length} external authority links`);

      authorityLinks = mergeWithDiscovered(curatedLinks, discoveredLinks);
      fileSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    } catch (setupError: unknown) {
      // Safely extract a printable message — plain objects produce "[object Object]"
      // via String(), so we JSON-stringify them for the log but use a clean fallback
      // for the user-facing message.
      let msg: string;
      if (setupError instanceof Error) {
        msg = setupError.message || "Unknown error";
      } else if (typeof setupError === "string") {
        msg = setupError;
      } else {
        // Plain object or unknown type: log the full shape, show clean message to user
        try { console.error("[generate] Setup error (non-Error):", JSON.stringify(setupError)); } catch { /* circular */ }
        msg = "An unexpected error occurred during pipeline setup.";
      }
      console.error(`[generate] Setup failed: ${msg}`);
      await send({ type: "error", message: msg });
      return;
    }

    // ── Tech retry loop (content + images only) ───────────────
    for (let techAttempt = 1; techAttempt <= MAX_TECH; techAttempt++) {

      try {
        // ── QA retry loop ─────────────────────────────────────
        const MAX_QA   = 3;

        // State carried across retries so fix passes can build on prior work
        let prevContent:      BlogContent | null = null;
        let prevImagePrompts: ImagePrompts | null = null;
        let prevQAChecks:     Record<string, boolean> | null = null;
        let prevBrokenUrls:   string[] = [];

        for (let qaAttempt = 1; qaAttempt <= MAX_QA; qaAttempt++) {
          let content:      BlogContent;
          let imagePrompts: ImagePrompts;

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

          // ── Pass 1: strip URLs not on an approved domain ──────
          const approvedUrls = authorityLinks.map((l) => l.url);
          const { content: enforcedContent, removed: unapproved } = enforceApprovedLinks(content, approvedUrls);
          if (unapproved.length > 0) {
            console.warn(`[generate] Removed ${unapproved.length} unapproved external URL(s): ${unapproved.join(", ")}`);
          }
          content = enforcedContent;

          // ── Pass 2: remove genuine 404s only ──────────────────
          // 403/timeout = server blocked bot but page exists — keep.
          // Only a 404 is definitive proof the specific path doesn't exist.
          const { content: scrubbedContent, removed: brokenUrls } = await scrubBrokenExternalLinks(content);
          if (brokenUrls.length > 0) {
            console.warn(`[generate] Removed ${brokenUrls.length} 404 external link(s): ${brokenUrls.join(", ")}`);
          }
          content = scrubbedContent;
          prevBrokenUrls = [...unapproved, ...brokenUrls];

          // ── Pass 3: strip any links GPT placed inside visual blocks ──
          content = stripLinksFromVisualBlocks(content);

          // ── Image prompts: regenerate only on attempt 1 or if image checks failed ─
          // Actual image generation happens in a separate /api/generate-images call
          // after this route returns "done" — this keeps us well under the 300s limit.
          const needNewImagePrompts = qaAttempt === 1 || IMAGE_QA_CHECKS.some((k) => !prevQAChecks![k]);
          if (needNewImagePrompts) {
            imagePrompts = await generateImagePrompts(title, content);
          } else {
            imagePrompts = prevImagePrompts!;
          }

          // Auto-correct house style: "licence" variants → "license" regardless of AI output
          const licenceMap: [RegExp, string][] = [
            [/\blicenc(e)\b/gi, "licens$1"],
            [/\blicenc(es)\b/gi, "licens$1"],
            [/\blicenc(ed)\b/gi, "licens$1"],
            [/\blicenc(ing)\b/gi, "licens$1"],
          ];
          const applyLicenceFix = (s: string) =>
            licenceMap.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
          const contentKeys = [
            "main_content","more_content_1","more_content_2","more_content_3",
            "more_content_4","more_content_5","more_content_6",
            "keypoint_one","keypoint_two","quote_1","quote_2",
            "key_takeaways","final_points","excerpt",
            "seo_title","meta_description",
            // focus_keyword + slug MUST be normalised too, otherwise a "licence"
            // keyword can never match the "license"-corrected title and the
            // focus_keyword_in_title check fails on every attempt.
            "focus_keyword","slug",
          ] as const;
          for (const key of contentKeys) {
            if (typeof content[key] === "string") {
              content[key] = applyLicenceFix(content[key] as string);
            }
          }
          // secondary_keywords is an array — normalise each entry for consistency
          if (Array.isArray(content.secondary_keywords)) {
            content.secondary_keywords = content.secondary_keywords.map((k) =>
              typeof k === "string" ? applyLicenceFix(k) : k
            );
          }

          const placeholderImageIds = { keypointOneImg: 0, keypointTwoImg: 0, postSplitImg: 0, featuredImg: 0 };
          const qa = runQA(content, imagePrompts, placeholderImageIds, title);
          // Override the LLM's estimated read_mins with a value derived from the
          // actual stripped word count — the LLM over-counts by including HTML markup.
          content.read_mins = String(Math.max(1, Math.round(qa.wordCount / 200)));
          console.log(`[generate] QA attempt ${qaAttempt}: ${qa.status.toUpperCase()} (${qa.score}/100, ${qa.wordCount} words, ${content.read_mins} min read)`);

          // Persist state for next retry
          prevContent      = content;
          prevImagePrompts = imagePrompts;
          prevQAChecks     = qa.checks;

          if (qa.status === "fail") {
            console.warn(`[generate] QA FAIL (${qaAttempt}/${MAX_QA}) — ${qa.blocking_issues.join("; ")}`);
            if (qaAttempt < MAX_QA) continue;
            await send({ type: "error", message: `Post failed QA after ${MAX_QA} attempts: ${qa.blocking_issues.join("; ")}` });
            return;
          }

          // Retry-worthy warnings: not blocking (we never discard the article over
          // them), but important enough to spend a fix pass on. These commonly never
          // get fixed because a "warn" status publishes as-is.
          // Bounded to ONE extra fix pass (only after attempt 1) so common warnings
          // can't push a near-budget run over the 300s function limit — blocking
          // failures still get the full MAX_QA attempts above. The first fix pass
          // captures the bulk of the quality benefit.
          if (qaAttempt === 1) {
            const retryableFailures = RETRYABLE_WARNING_CHECKS.filter((k) => qa.checks[k] === false);
            if (retryableFailures.length > 0) {
              console.warn(`[generate] QA WARN (${qaAttempt}/${MAX_QA}) — attempting one fix pass for: ${retryableFailures.join(", ")}`);
              continue;
            }
          }

          // IMGSLOT_* markers are replaced with "" here — the actual images are
          // attached later by /api/generate-images which patches the WP post.
          // [FLOWCHART_IMG] is left in place so generate-images can replace it
          // with the rendered Mermaid PNG <img> tag.
          const assembled = {
            main_content:   content.main_content.replace("IMGSLOT_MAIN", ""),
            more_content_1: content.more_content_1.replace("IMGSLOT_ONE", ""),
            more_content_3: content.more_content_3.replace("IMGSLOT_TWO", ""),
            more_content_4: content.more_content_4.replace("IMGSLOT_SPLIT", ""),
          };

          const post = await createWordPressPost(content.seo_title || title, content, imagePrompts, assembled, null, language || undefined);
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
            imageIds:         null,   // images generated separately via /api/generate-images
            imagePrompts,             // forwarded by client to /api/generate-images
            fileSlug,                 // forwarded by client to /api/generate-images
            imageModel,               // forwarded by client to /api/generate-images
            flowchartMermaid: content.flowchart_mermaid ?? "", // forwarded to /api/generate-images
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
            // Article content fields — used by audio generation.
            // Use assembled.* for fields that had IMGSLOT_* markers replaced.
            // key_takeaways intentionally excluded — not narrated in audio.
            main_content:   assembled.main_content   ?? "",
            more_content_1: assembled.more_content_1 ?? "",
            more_content_2: content.more_content_2   ?? "",
            more_content_3: assembled.more_content_3 ?? "",
            more_content_4: assembled.more_content_4 ?? "",
            more_content_5: content.more_content_5   ?? "",
            more_content_6: content.more_content_6   ?? "",
            final_points:   content.final_points     ?? "",
          });
          return; // success — close stream
        }

        return; // QA loop exhausted (error already sent)

      } catch (error: unknown) {
        const msg = error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : "An unexpected error occurred.";
        // WordPress / upload errors are not fixed by regenerating content — fail fast.
        const isFatalError = msg.includes("WP post creation failed") ||
                             msg.includes("Image upload") ||
                             msg.includes("upload");
        if (!isFatalError && techAttempt < MAX_TECH) {
          console.warn(`[generate] Technical error (attempt ${techAttempt}/${MAX_TECH}), retrying: ${msg}`);
          await send({ type: "tech_retry", attempt: techAttempt + 1, max: MAX_TECH, reason: msg });
        } else {
          console.error(`[generate] Fatal error (attempt ${techAttempt}/${MAX_TECH}): ${msg}`);
          await send({ type: "error", message: msg });
          return;
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
