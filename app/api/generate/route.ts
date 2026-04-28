/**
 * app/api/generate/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate
 *
 * Runs on Vercel — trusted IPs that SiteGround never blocks.
 *
 * Pipeline:
 *  1.  Validate request + API secret
 *  2.  Process source input into a brief (Modes B/C/D only)
 *  3.  Select relevant links for the topic
 *  4.  Generate structure blueprint with GPT-4o
 *  5.  Generate full article content from blueprint with GPT-4o
 *  6.  Generate 4 content-aware image prompts with GPT-4o
 *  7.  Generate 4 images with Imagen 3 (in parallel)
 *  8.  Upload images to WordPress media library (in parallel)
 *  9.  Run QA engine — fail hard on blocking issues, flag warnings
 *  10. Create WordPress draft post with all ACF + Yoast fields
 *  11. Return the draft post URL with QA report
 */

import { NextRequest, NextResponse } from "next/server";
import { generateBlueprint, generateBlogContent, generateImagePrompts, generateImage } from "@/lib/openai";
import { uploadImageToWordPress, createWordPressPost } from "@/lib/wordpress";
import { selectLinks } from "@/lib/links";
import { runQA } from "@/lib/qa";
import {
  GenerationMode,
  SourceBrief,
  emptyBrief,
  processSourceInput,
} from "@/lib/source";
import { generateStrategy, StrategyBrief } from "@/lib/strategy";
import { researchTopic, deriveTitle, ResearchBrief } from "@/lib/research";

// Research (~15s) + strategy (~40s) + content (~120s) + images (~60s).
export const maxDuration = 300;


export async function POST(req: NextRequest) {
  try {
    // ── 1. Validate request ──────────────────────────────
    const body = await req.json();
    const {
      topic,
      secret,
      mode = "topic_only",
      sourceText = "",
      audience = "",
      primary_country = "",
      secondary_countries = "",
      priority_service = "",
      language = "",
      customPrompt = "",
    }: {
      topic: string;
      secret: string;
      mode: GenerationMode;
      sourceText: string;
      audience: string;
      primary_country: string;
      secondary_countries: string;
      priority_service: string;
      language: string;
      customPrompt: string;
    } = body;

    const hasTopic = topic && typeof topic === "string" && topic.trim().length >= 5;
    const hasCustomPrompt = customPrompt && typeof customPrompt === "string" && customPrompt.trim().length >= 10;

    if (!hasTopic && !hasCustomPrompt) {
      return NextResponse.json(
        { error: "Please provide a blog topic or a custom prompt (at least 10 characters)." },
        { status: 400 }
      );
    }
    if (!audience?.trim()) {
      return NextResponse.json(
        { error: "Please provide a target audience." },
        { status: 400 }
      );
    }

    if (secret !== process.env.API_SECRET) {
      return NextResponse.json(
        { error: "Unauthorized." },
        { status: 401 }
      );
    }

    const validModes: GenerationMode[] = [
      "topic_only",
      "source_assisted",
      "improve_existing",
      "notes_to_article",
    ];
    if (!validModes.includes(mode)) {
      return NextResponse.json({ error: "Invalid generation mode." }, { status: 400 });
    }

    if (mode !== "topic_only" && !sourceText?.trim()) {
      return NextResponse.json(
        { error: "Source text is required for this generation mode." },
        { status: 400 }
      );
    }

    const customInstruction = customPrompt.trim() || undefined;

    // ── 2. Derive title from custom prompt if no topic given ──
    let title: string;
    let strategyTopic: string;

    if (hasTopic) {
      title = topic.trim();
      strategyTopic = title;
    } else {
      console.log("[generate] No topic provided — deriving SEO title from custom prompt...");
      const derived = await deriveTitle(customInstruction!, primary_country || undefined);
      title = derived.title;
      strategyTopic = derived.topic;
      console.log(`[generate] Derived title: "${title}" (topic: "${strategyTopic}")`);
    }

    // ── 3. Deep SEO research ─────────────────────────────
    console.log(`[generate] Running SEO research for: "${title}"`);
    let research: ResearchBrief | undefined;
    try {
      research = await researchTopic(title, primary_country || undefined, customInstruction);
      console.log(`[generate] Research ready. Dominant keywords: ${research.dominant_keywords.slice(0, 4).join(", ")}`);
    } catch (err) {
      console.warn("[generate] Research step failed — continuing without SERP data:", err);
    }

    // ── 4. Run strategy engine ───────────────────────────
    console.log(`[generate] Running strategy engine for: "${strategyTopic}"`);
    const strategy: StrategyBrief = await generateStrategy({
      topic: strategyTopic,
      audience:            audience || undefined,
      primary_country:     primary_country || undefined,
      secondary_countries: secondary_countries || undefined,
      priority_service:    priority_service || undefined,
      language:            language || undefined,
      customPrompt:        customInstruction,
      research:            research,
    });
    console.log(`[generate] Strategy ready. Primary keyword: "${strategy.keyword_model.primary_keyword}", intent: ${strategy.search_intent_type}`);

    // ── 4. Process source input (Modes B / C / D) ────────
    let sourceBrief: SourceBrief;
    if (mode === "topic_only") {
      sourceBrief = emptyBrief();
    } else {
      console.log(`[generate] Processing source input (mode: ${mode})...`);
      sourceBrief = await processSourceInput(mode, title, sourceText);
      console.log(`[generate] Source brief ready: ${sourceBrief.summary}`);
    }

    // ── 4. Select relevant links ─────────────────────────
    console.log(`[generate] Starting for title: "${title}"`);
    const selectedLinks = await selectLinks(title, language || undefined);
    console.log(
      `[generate] Selected ${selectedLinks.internal.length} internal + ${selectedLinks.external.length} external links`
    );

    // ── 5. Generate structure blueprint ──────────────────
    console.log("[generate] Generating blueprint...");
    const blueprint = await generateBlueprint(title, selectedLinks, sourceBrief, strategy, customInstruction);
    console.log(
      `[generate] Blueprint ready. Focus keyword: "${blueprint.focus_keyword}", ~${blueprint.estimated_word_count} words`
    );

    // ── 6–12. Content → images → QA → post (up to 3 attempts) ──
    const MAX_ATTEMPTS = 3;
    const fileSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.log(`[generate] Retrying content generation (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      }

      // ── 6. Generate blog content from blueprint ─────────
      const content = await generateBlogContent(title, blueprint, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined);
      console.log(`[generate] Content ready (attempt ${attempt}). Slug: "${content.slug}", read: ${content.read_mins} min`);

      // ── 7. Generate content-aware image prompts ──────────
      const imagePrompts = await generateImagePrompts(title, content);

      // ── 8. Generate all 4 images in parallel ─────────────
      console.log("[generate] Generating images with Imagen 3...");
      const [kp1Buffer, kp2Buffer, splitBuffer, featuredBuffer] = await Promise.all([
        generateImage(imagePrompts.keypoint_one_img_prompt),
        generateImage(imagePrompts.keypoint_two_img_prompt),
        generateImage(imagePrompts.post_split_img_prompt),
        generateImage(imagePrompts.featured_img_prompt),
      ]);

      // ── 9. Upload images to WordPress ────────────────────
      const [kp1Media, kp2Media, splitMedia, featuredMedia] = await Promise.all([
        uploadImageToWordPress(kp1Buffer, `${fileSlug}-kp1.png`, imagePrompts.keypoint_one_img_alt),
        uploadImageToWordPress(kp2Buffer, `${fileSlug}-kp2.png`, imagePrompts.keypoint_two_img_alt),
        uploadImageToWordPress(splitBuffer, `${fileSlug}-split.png`, imagePrompts.post_split_img_alt),
        uploadImageToWordPress(featuredBuffer, `${fileSlug}-featured.png`, imagePrompts.featured_img_alt),
      ]);
      console.log(`[generate] Images uploaded: ${kp1Media.id}, ${kp2Media.id}, ${splitMedia.id}, ${featuredMedia.id}`);

      const imageIds = {
        keypointOneImg: kp1Media.id,
        keypointTwoImg: kp2Media.id,
        postSplitImg:   splitMedia.id,
        featuredImg:    featuredMedia.id,
      };

      // ── 10. Run QA ────────────────────────────────────────
      const qa = runQA(content, imagePrompts, imageIds, title);
      console.log(`[generate] QA attempt ${attempt}: ${qa.status.toUpperCase()} (score ${qa.score}/100, ${qa.wordCount} words)`);

      if (qa.status === "fail") {
        const issues = qa.blocking_issues.join("; ");
        console.warn(`[generate] QA FAIL (attempt ${attempt}/${MAX_ATTEMPTS}) — ${issues}`);
        if (attempt < MAX_ATTEMPTS) continue;
        return NextResponse.json(
          { error: `Post failed QA after ${MAX_ATTEMPTS} attempts. Blocking issues: ${issues}`, qa },
          { status: 422 }
        );
      }

      if (qa.warnings.length > 0) {
        console.warn(`[generate] QA warnings: ${qa.warnings.join(" | ")}`);
      }

      // ── 11. Strip IMGSLOT placeholders (images handled by ACF) ─
      const assembled = {
        main_content:   content.main_content.replace("IMGSLOT_MAIN", ""),
        more_content_1: content.more_content_1.replace("IMGSLOT_ONE", ""),
        more_content_3: content.more_content_3.replace("IMGSLOT_TWO", ""),
        more_content_4: content.more_content_4.replace("IMGSLOT_SPLIT", ""),
      };

      // ── 12. Create the WordPress post ────────────────────
      console.log("[generate] Creating WordPress post...");
      const post = await createWordPressPost(content.seo_title || title, content, imagePrompts, assembled, imageIds);
      console.log(`[generate] Post created! ID: ${post.id}, slug: "${content.slug}"`);

      // ── 13. Return success ────────────────────────────────
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

      return NextResponse.json({
        success: true,
        postId: post.id,
        mode,
        title,
        slug: content.slug,
        focusKeyword: content.focus_keyword,
        seoTitle: content.seo_title,
        readMins: content.read_mins,
        wordCount: qa.wordCount,
        qaAttempts: attempt,
        strategy: {
          searchIntentType: strategy.search_intent_type,
          primaryKeyword: strategy.keyword_model.primary_keyword,
          articleAngle: strategy.article_angle.slice(0, 200),
        },
        qa: {
          status: qa.status,
          score: qa.score,
          warnings: qa.warnings,
        },
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
    }

    return NextResponse.json({ error: "Unexpected state after retry loop" }, { status: 500 });

  } catch (error: unknown) {
    console.error("[generate] Error:", error);

    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";

    console.error(
      "[generate] Full error:",
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
