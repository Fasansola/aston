/**
 * lib/workflows/generatePost.ts
 * ─────────────────────────────────────────────────────────────
 * Durable, resumable port of the /api/generate pipeline using the
 * Workflow DevKit.
 *
 * WHY: the old monolithic route ran the entire 3–5 minute pipeline inside one
 * 300s Vercel function. Any slow step tipped it over the wall and the function
 * was killed mid-way, discarding all work. Here every stage is a durable
 * "use step": each is checkpointed and auto-retried, and if the function is
 * killed the workflow RESUMES from the last completed step — a strategy or
 * content generation that already succeeded is never re-run.
 *
 * Two behavioural guarantees (per product decision):
 *  - Long articles are fine — no single step risks the 300s wall.
 *  - Nothing is ever discarded. On QA exhaustion the article is still saved as
 *    a WordPress draft and the client is notified which checks need review.
 *
 * Steps wrap the EXISTING lib functions unchanged; the orchestrator only
 * coordinates them and streams progress. All step I/O is plain-object
 * serializable (BlogContent, Blueprint, StrategyBrief, etc.).
 *
 * Progress is streamed in the SAME SSE event shape the old route used, so the
 * client's existing event handling keeps working:
 *   { type: "progress", message }   { type: "qa_retry", attempt, max }
 *   { type: "done", success, ... }  { type: "error", message }
 */

import { getWritable, FatalError } from "workflow";

import {
  generateBlueprint, generateBlogContent, fixBlogContent,
  generateImagePrompts, IMAGE_QA_CHECKS, type ImageModel,
} from "@/lib/openai";
import { createWordPressPost, type BlogContent, type ImagePrompts } from "@/lib/wordpress";
import { selectLinks } from "@/lib/links";
import { runQA, RETRYABLE_WARNING_CHECKS } from "@/lib/qa";
import { enforceApprovedLinks, scrubBrokenExternalLinks, stripLinksFromVisualBlocks } from "@/lib/linkScrubber";
import { selectAuthorityLinks, mergeWithDiscovered, type AuthorityLink } from "@/lib/authorityLinks";
import { GenerationMode, SourceBrief, emptyBrief, processSourceInput } from "@/lib/source";
import { generateStrategy, type StrategyBrief } from "@/lib/strategy";
import { researchTopic, deriveTitle, findExternalAuthorityLinks, type ResearchBrief } from "@/lib/research";
import type { Blueprint } from "@/lib/wordpress";
import type { SelectedLinks } from "@/lib/links";

const MAX_QA = 3;

// ── Serializable workflow input ───────────────────────────────
export interface GeneratePostInput {
  hasTopic: boolean;
  title: string;             // topic (if hasTopic) else "" and derived in a step
  mode: GenerationMode;
  sourceText: string;
  audience: string;
  primary_country: string;
  secondary_countries: string;
  priority_service: string;
  language: string;
  customInstruction?: string;
  imageModel: ImageModel;
}

// ── Progress streaming (must happen in a step, not the workflow) ──
type SseEvent = Record<string, unknown>;

async function emit(event: SseEvent): Promise<void> {
  "use step";
  const writer = getWritable<string>().getWriter();
  try {
    await writer.write(`data: ${JSON.stringify(event)}\n\n`);
  } finally {
    writer.releaseLock();
  }
}

async function closeStream(): Promise<void> {
  "use step";
  await getWritable<string>().close();
}

// ── Setup steps ───────────────────────────────────────────────

async function deriveTitleStep(customInstruction: string, primaryCountry: string): Promise<{ title: string; topic: string }> {
  "use step";
  return deriveTitle(customInstruction, primaryCountry || undefined);
}

async function researchStep(title: string, primaryCountry: string, customInstruction?: string): Promise<ResearchBrief | null> {
  "use step";
  // Research is best-effort — never let a SERP hiccup fail the whole run.
  try {
    return await researchTopic(title, primaryCountry || undefined, customInstruction);
  } catch (err) {
    console.warn("[wf] research failed, continuing without SERP data:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function selectLinksStep(title: string, language: string): Promise<SelectedLinks> {
  "use step";
  return selectLinks(title, language || undefined);
}

async function sourceBriefStep(mode: GenerationMode, title: string, sourceText: string): Promise<SourceBrief> {
  "use step";
  if (mode === "topic_only") return emptyBrief();
  return processSourceInput(mode as Parameters<typeof processSourceInput>[0], title, sourceText);
}

async function strategyStep(input: GeneratePostInput, strategyTopic: string, research: ResearchBrief | null): Promise<StrategyBrief> {
  "use step";
  return generateStrategy({
    topic:               strategyTopic,
    audience:            input.audience || undefined,
    primary_country:     input.primary_country || undefined,
    secondary_countries: input.secondary_countries || undefined,
    priority_service:    input.priority_service || undefined,
    language:            input.language || undefined,
    customPrompt:        input.customInstruction,
    research:            research ?? undefined,
  });
}

async function blueprintStep(
  title: string, selectedLinks: SelectedLinks, sourceBrief: SourceBrief,
  strategy: StrategyBrief, customInstruction: string | undefined, language: string
): Promise<Blueprint> {
  "use step";
  return generateBlueprint(title, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined);
}

async function authorityLinksStep(
  title: string, strategy: StrategyBrief
): Promise<AuthorityLink[]> {
  "use step";
  const jurisdictions = (strategy?.jurisdiction_map ?? []).map((j) => j.jurisdiction);
  const curated = selectAuthorityLinks(`${title} ${strategy?.keyword_model.primary_keyword ?? ""}`, jurisdictions);
  let discovered: Awaited<ReturnType<typeof findExternalAuthorityLinks>> = [];
  try {
    discovered = await findExternalAuthorityLinks(title, strategy?.keyword_model.primary_keyword ?? title, jurisdictions);
  } catch (err) {
    console.warn("[wf] authority link discovery failed, using curated list only:", err instanceof Error ? err.message : err);
  }
  return mergeWithDiscovered(curated, discovered);
}

// ── Content + fix steps ───────────────────────────────────────

async function contentStep(
  title: string, blueprint: Blueprint, selectedLinks: SelectedLinks,
  sourceBrief: SourceBrief, strategy: StrategyBrief,
  customInstruction: string | undefined, language: string, authorityLinks: AuthorityLink[]
): Promise<BlogContent> {
  "use step";
  return generateBlogContent(title, blueprint, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined, authorityLinks);
}

async function fixStep(
  title: string, prevContent: BlogContent, blueprint: Blueprint, selectedLinks: SelectedLinks,
  failingChecks: Record<string, boolean>, language: string, brokenUrls: string[], authorityLinks: AuthorityLink[]
): Promise<BlogContent> {
  "use step";
  return fixBlogContent(title, prevContent, blueprint, selectedLinks, failingChecks, language || undefined, brokenUrls.length > 0 ? brokenUrls : undefined, authorityLinks);
}

// ── Link enforcement + house-style normalisation (one step) ────

const LICENCE_MAP: [RegExp, string][] = [
  [/\blicenc(e)\b/gi, "licens$1"],
  [/\blicenc(es)\b/gi, "licens$1"],
  [/\blicenc(ed)\b/gi, "licens$1"],
  [/\blicenc(ing)\b/gi, "licens$1"],
];
const applyLicenceFix = (s: string) => LICENCE_MAP.reduce((acc, [re, rep]) => acc.replace(re, rep), s);

async function scrubStep(
  content: BlogContent, authorityLinks: AuthorityLink[], prevBrokenUrls: string[]
): Promise<{ content: BlogContent; brokenUrls: string[] }> {
  "use step";
  // Pass 1 — strip URLs not on an approved domain
  const approvedUrls = authorityLinks.map((l) => l.url);
  const { content: enforced, removed: unapproved } = enforceApprovedLinks(content, approvedUrls);
  // Pass 2 — remove genuine 404s
  const { content: scrubbed, removed: broken } = await scrubBrokenExternalLinks(enforced);
  // Pass 3 — strip links inside visual blocks
  let out = stripLinksFromVisualBlocks(scrubbed);

  // House style: "licence" → "license" across all text fields (incl. focus_keyword
  // + slug, so the focus_keyword_in_title QA check can't permanently fail).
  const keys = [
    "main_content","more_content_1","more_content_2","more_content_3","more_content_4","more_content_5","more_content_6",
    "keypoint_one","keypoint_two","quote_1","quote_2","key_takeaways","final_points","excerpt",
    "seo_title","meta_description","focus_keyword","slug",
  ] as const;
  out = { ...out };
  const rec = out as unknown as Record<string, unknown>;
  for (const k of keys) {
    if (typeof rec[k] === "string") {
      rec[k] = applyLicenceFix(rec[k] as string);
    }
  }
  if (Array.isArray(out.secondary_keywords)) {
    out.secondary_keywords = out.secondary_keywords.map((k) => (typeof k === "string" ? applyLicenceFix(k) : k));
  }

  return { content: out, brokenUrls: [...new Set([...prevBrokenUrls, ...unapproved, ...broken])] };
}

// ── Image prompts + QA ────────────────────────────────────────

async function imagePromptsStep(title: string, content: BlogContent): Promise<ImagePrompts> {
  "use step";
  return generateImagePrompts(title, content);
}

const PLACEHOLDER_IMAGE_IDS = { keypointOneImg: 0, keypointTwoImg: 0, postSplitImg: 0, featuredImg: 0 };

async function qaStep(
  content: BlogContent, imagePrompts: ImagePrompts, title: string
): Promise<{ qa: ReturnType<typeof runQA>; readMins: string }> {
  "use step";
  const qa = runQA(content, imagePrompts, PLACEHOLDER_IMAGE_IDS, title);
  const readMins = String(Math.max(1, Math.round(qa.wordCount / 200)));
  return { qa, readMins };
}

// ── Publish ────────────────────────────────────────────────────

async function publishStep(
  title: string, content: BlogContent, imagePrompts: ImagePrompts, language: string,
  wpStatus: "draft" | "publish" = "publish"
): Promise<{
  postId: number; link: string | null; articleHtml: string;
  assembled: { main_content: string; more_content_1: string; more_content_3: string; more_content_4: string };
}> {
  "use step";
  // IMGSLOT_* markers are placeholders the image step replaces later.
  const assembled = {
    main_content:   content.main_content.replace("IMGSLOT_MAIN", ""),
    more_content_1: content.more_content_1.replace("IMGSLOT_ONE", ""),
    more_content_3: content.more_content_3.replace("IMGSLOT_TWO", ""),
    more_content_4: content.more_content_4.replace("IMGSLOT_SPLIT", ""),
  };
  const post = await createWordPressPost(content.seo_title || title, content, imagePrompts, assembled, null, language || undefined, wpStatus);
  const articleHtml = [
    content.key_takeaways, assembled.main_content, content.keypoint_one, assembled.more_content_1,
    content.more_content_2, content.quote_1, assembled.more_content_3, content.keypoint_two,
    assembled.more_content_4, content.quote_2, content.more_content_5, content.more_content_6, content.final_points,
  ].filter(Boolean).join("\n");
  // Extract only JSON-serializable scalars — WDK rejects step return values
  // that contain functions or prototype-inherited methods.
  return {
    postId: typeof post?.id === "number" ? post.id : 0,
    link:   typeof post?.link === "string" ? post.link : null,
    articleHtml,
    assembled,
  };
}

// Build the full `done` event payload — matches the old /api/generate contract
// so the client's downstream (image generation, audio, link validation) works
// identically. Pure object construction is safe in workflow context.
function buildDoneEvent(args: {
  published: Awaited<ReturnType<typeof publishStep>>;
  content: BlogContent;
  imagePrompts: ImagePrompts;
  fileSlug: string;
  imageModel: ImageModel;
  readMins: string;
  wordCount: number;
  language: string;
  needsReview: boolean;
  failingChecks?: string[];
  qa?: { status: string; score: number; warnings: string[] };
}): Record<string, unknown> {
  const { published, content, imagePrompts, fileSlug, imageModel, readMins, wordCount, language } = args;
  return {
    type: "done", success: true,
    needsReview: args.needsReview,
    ...(args.failingChecks ? { failingChecks: args.failingChecks } : {}),
    ...(args.qa ? { qa: args.qa } : {}),
    postId: published.postId,
    slug: content.slug,
    title: content.seo_title,
    focusKeyword: content.focus_keyword,
    seoTitle: content.seo_title,
    readMins, wordCount,
    previewUrl: published.link,
    editUrl: published.postId ? `${process.env.WP_URL}/wp-admin/post.php?post=${published.postId}&action=edit` : "",
    articleHtml: published.articleHtml,
    excerpt: content.excerpt,
    metaDescription: content.meta_description,
    tags: content.secondary_keywords ?? [],
    language: language || null,
    // Downstream triggers (image generation in a separate request)
    imagePrompts, fileSlug, imageModel,
    flowchartMermaid: content.flowchart_mermaid ?? "",
    // Link validation
    linksUsed: { internal: content.internal_links_used ?? [], external: content.external_links_used ?? [] },
    // Raw fields for audio narration (assembled where IMGSLOTs were stripped)
    main_content:   published.assembled.main_content,
    more_content_1: published.assembled.more_content_1,
    more_content_2: content.more_content_2 ?? "",
    more_content_3: published.assembled.more_content_3,
    more_content_4: published.assembled.more_content_4,
    more_content_5: content.more_content_5 ?? "",
    more_content_6: content.more_content_6 ?? "",
    final_points:   content.final_points ?? "",
    message: args.needsReview
      ? `Saved as draft — these checks need review: ${(args.failingChecks ?? []).join(", ")}`
      : undefined,
  };
}

// ── Orchestrator ──────────────────────────────────────────────

export async function generatePostWorkflow(input: GeneratePostInput): Promise<{ postId: number; needsReview: boolean }> {
  "use workflow";

  try {
  console.log("[wf] start — hasTopic:", input.hasTopic, "mode:", input.mode, "lang:", input.language);
  await emit({ type: "progress", message: "Researching and planning…" });

  // Title / topic
  let title = input.title;
  let strategyTopic = input.title;
  if (!input.hasTopic) {
    console.log("[wf] step: deriveTitle");
    const derived = await deriveTitleStep(input.customInstruction ?? "", input.primary_country);
    title = derived.title;
    strategyTopic = derived.topic;
    console.log("[wf] deriveTitle done — title:", title);
  }

  const fileSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);

  // Setup (steps auto-retry transient errors; research/authority degrade gracefully)
  console.log("[wf] step: research");
  const research = await researchStep(title, input.primary_country, input.customInstruction);
  console.log("[wf] step: selectLinks");
  const selectedLinks = await selectLinksStep(title, input.language);
  console.log("[wf] step: sourceBrief");
  const sourceBrief = await sourceBriefStep(input.mode, title, input.sourceText);
  console.log("[wf] step: strategy");
  const strategy = await strategyStep(input, strategyTopic, research);
  await emit({ type: "progress", message: `Strategy ready — keyword "${strategy.keyword_model.primary_keyword}"` });
  console.log("[wf] step: blueprint");
  const blueprint = await blueprintStep(title, selectedLinks, sourceBrief, strategy, input.customInstruction, input.language);
  console.log("[wf] step: authorityLinks");
  const authorityLinks = await authorityLinksStep(title, strategy);
  await emit({ type: "progress", message: "Writing the article…" });

  // QA loop
  let prevContent: BlogContent | null = null;
  let prevImagePrompts: ImagePrompts | null = null;
  let prevChecks: Record<string, boolean> | null = null;
  let prevBrokenUrls: string[] = [];

  for (let attempt = 1; attempt <= MAX_QA; attempt++) {
    console.log("[wf] step: content attempt", attempt);
    let content: BlogContent = attempt === 1
      ? await contentStep(title, blueprint, selectedLinks, sourceBrief, strategy, input.customInstruction, input.language, authorityLinks)
      : await fixStep(title, prevContent!, blueprint, selectedLinks, prevChecks!, input.language, prevBrokenUrls, authorityLinks);
    console.log("[wf] step: scrub attempt", attempt);
    const scrubbed = await scrubStep(content, authorityLinks, prevBrokenUrls);
    content = scrubbed.content;
    prevBrokenUrls = scrubbed.brokenUrls;

    const needNewImagePrompts = attempt === 1 || IMAGE_QA_CHECKS.some((k) => !prevChecks![k]);
    console.log("[wf] step: imagePrompts attempt", attempt, "regen:", needNewImagePrompts);
    const imagePrompts: ImagePrompts = needNewImagePrompts ? await imagePromptsStep(title, content) : prevImagePrompts!;
    console.log("[wf] step: qa attempt", attempt);
    const { qa, readMins } = await qaStep(content, imagePrompts, title);
    content = { ...content, read_mins: readMins };
    console.log("[wf] qa result — status:", qa.status, "score:", qa.score);

    prevContent = content;
    prevImagePrompts = imagePrompts;
    prevChecks = qa.checks;

    if (qa.status === "fail") {
      if (attempt < MAX_QA) {
        await emit({ type: "qa_retry", attempt: attempt + 1, max: MAX_QA });
        continue;
      }
      // EXHAUSTED — save as draft (failed QA should not go live) + notify.
      console.log("[wf] step: publish (qa-exhausted)");
      const published = await publishStep(title, content, imagePrompts, input.language, "draft");
      await emit(buildDoneEvent({
        published, content, imagePrompts, fileSlug, imageModel: input.imageModel,
        readMins, wordCount: qa.wordCount, language: input.language,
        needsReview: true, failingChecks: qa.blocking_issues,
      }));
      await closeStream();
      console.log("[wf] done (needs review), postId:", published.postId);
      return { postId: published.postId, needsReview: true };
    }

    // First pass with retryable warnings → one targeted fix pass
    if (attempt === 1) {
      const retryable = RETRYABLE_WARNING_CHECKS.filter((k) => qa.checks[k] === false);
      if (retryable.length > 0) {
        await emit({ type: "qa_retry", attempt: attempt + 1, max: MAX_QA });
        continue;
      }
    }

    // PASS → publish draft
    console.log("[wf] step: publish (pass)");
    const published = await publishStep(title, content, imagePrompts, input.language);
    await emit(buildDoneEvent({
      published, content, imagePrompts, fileSlug, imageModel: input.imageModel,
      readMins, wordCount: qa.wordCount, language: input.language,
      needsReview: false, qa: { status: qa.status, score: qa.score, warnings: qa.warnings },
    }));
    await closeStream();
    console.log("[wf] done, postId:", published.postId);
    return { postId: published.postId, needsReview: false };
  }

  // Unreachable — the loop always returns. Fatal so it surfaces if logic changes.
  throw new FatalError("QA loop exited without publishing");
  } catch (err) {
    // A step failed after exhausting WDK's retries (or a fatal error like a bad
    // API key). Log the real cause (visible in Vercel function logs), tell the
    // client, close the stream so it never hangs, then re-throw so the run is
    // marked failed in observability.
    const errName = err instanceof Error ? err.constructor.name : typeof err;
    const errMsg  = err instanceof Error
      ? err.message
      : typeof err === "string"
      ? err
      : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
    console.error(`[generatePost] Workflow failed — ${errName}: ${errMsg}`, err);
    const message = errMsg || "Generation failed unexpectedly. Please try again.";
    await emit({ type: "error", message });
    await closeStream();
    throw err;
  }
}
