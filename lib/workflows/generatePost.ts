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

import { getWritable, FatalError, sleep } from "workflow";
import { humaniseError } from "@/lib/errors";
import { draftKeyFor, inputSignature, DRAFT_STAGE_LABELS } from "@/lib/draftCore";
import type { GenerationDraft, DraftQa } from "@/lib/drafts";

import {
  generateBlueprint, generateBlogContent, fixBlogContent,
  generateImagePrompts, type ImageModel,
} from "@/lib/openai";
import { createWordPressPost, embedFlowchartHtml, SiteGroundBlockedError, type BlogContent, type ImagePrompts } from "@/lib/wordpress";
import { selectLinks } from "@/lib/links";
import { runQA, RETRYABLE_WARNING_CHECKS, shortenKeypoint, KEYPOINT_MAX_CHARS } from "@/lib/qa";
import { enforceApprovedLinks, scrubBrokenExternalLinks, stripLinksFromVisualBlocks } from "@/lib/linkScrubber";
import { selectAuthorityLinks, mergeWithDiscovered, type AuthorityLink } from "@/lib/authorityLinks";
import { GenerationMode, SourceBrief, emptyBrief, processSourceInput } from "@/lib/source";
import { generateStrategy, type StrategyBrief } from "@/lib/strategy";
import { researchTopic, deriveTitle, findExternalAuthorityLinks, type ResearchBrief } from "@/lib/research";
import type { Blueprint } from "@/lib/wordpress";
import type { SelectedLinks } from "@/lib/links";

const MAX_QA = 3;

// ── LLM step guard ─────────────────────────────────────────────
// Wraps every model-calling step so that (1) token usage is attributed to the
// run (lib/usage.ts → run log + monthly totals) and (2) a NON-retryable OpenAI
// failure — no credits, bad key, unknown model, rejected request — becomes a
// FatalError. That stops WDK's three automatic retries and fails the run in
// seconds with the operator-facing message, instead of minutes later with a
// stack trace that starts with an internal step name.
interface StepCtx { runLogId?: string }

async function guarded<T>(step: string, ctx: StepCtx, fn: () => Promise<T>): Promise<T> {
  const { withUsageContext } = await import("@/lib/usage");
  const { isNonRetryableLlmError } = await import("@/lib/llm");
  try {
    return await withUsageContext({ runLogId: ctx.runLogId, step }, fn);
  } catch (err) {
    if (isNonRetryableLlmError(err)) throw new FatalError(err.message);
    throw err;
  }
}

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
  // ── Queue context (scheduled/instant runs only) ─────────────
  // When set, the workflow owns the queue bookkeeping the cron used to do
  // inline: item progress/completion/failure, the per-run log entry, and
  // starting the post-publish media workflow (which now always includes
  // images). Browser runs omit these and behave exactly as before.
  queueItemId?: string;
  runLogId?: string;
  mediaOutputs?: { audio?: boolean; video?: boolean; podcast?: boolean };
  podcastLength?: number;
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

async function deriveTitleStep(customInstruction: string, primaryCountry: string, ctx: StepCtx): Promise<{ title: string; topic: string }> {
  "use step";
  return guarded("deriveTitle", ctx, () => deriveTitle(customInstruction, primaryCountry || undefined));
}

async function researchStep(title: string, primaryCountry: string, customInstruction: string | undefined, ctx: StepCtx): Promise<ResearchBrief | null> {
  "use step";
  // Research is best-effort — never let a SERP hiccup fail the whole run.
  try {
    const { withUsageContext } = await import("@/lib/usage");
    return await withUsageContext({ runLogId: ctx.runLogId, step: "research" }, () =>
      researchTopic(title, primaryCountry || undefined, customInstruction));
  } catch (err) {
    console.warn("[wf] research failed, continuing without SERP data:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function selectLinksStep(title: string, language: string): Promise<SelectedLinks> {
  "use step";
  return selectLinks(title, language || undefined);
}

async function sourceBriefStep(mode: GenerationMode, title: string, sourceText: string, ctx: StepCtx): Promise<SourceBrief> {
  "use step";
  if (mode === "topic_only") return emptyBrief();
  return guarded("sourceBrief", ctx, () =>
    processSourceInput(mode as Parameters<typeof processSourceInput>[0], title, sourceText));
}

async function strategyStep(input: GeneratePostInput, strategyTopic: string, research: ResearchBrief | null): Promise<StrategyBrief> {
  "use step";
  return guarded("strategy", { runLogId: input.runLogId }, () => generateStrategy({
    topic:               strategyTopic,
    audience:            input.audience || undefined,
    primary_country:     input.primary_country || undefined,
    secondary_countries: input.secondary_countries || undefined,
    priority_service:    input.priority_service || undefined,
    language:            input.language || undefined,
    customPrompt:        input.customInstruction,
    research:            research ?? undefined,
  }));
}

async function blueprintStep(
  title: string, selectedLinks: SelectedLinks, sourceBrief: SourceBrief,
  strategy: StrategyBrief, customInstruction: string | undefined, language: string, ctx: StepCtx
): Promise<Blueprint> {
  "use step";
  return guarded("blueprint", ctx, () =>
    generateBlueprint(title, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined));
}

async function authorityLinksStep(
  title: string, strategy: StrategyBrief, ctx: StepCtx
): Promise<AuthorityLink[]> {
  "use step";
  const jurisdictions = (strategy?.jurisdiction_map ?? []).map((j) => j.jurisdiction);
  const curated = selectAuthorityLinks(`${title} ${strategy?.keyword_model.primary_keyword ?? ""}`, jurisdictions);
  let discovered: Awaited<ReturnType<typeof findExternalAuthorityLinks>> = [];
  try {
    const { withUsageContext } = await import("@/lib/usage");
    discovered = await withUsageContext({ runLogId: ctx.runLogId, step: "authorityLinks" }, () =>
      findExternalAuthorityLinks(title, strategy?.keyword_model.primary_keyword ?? title, jurisdictions));
  } catch (err) {
    console.warn("[wf] authority link discovery failed, using curated list only:", err instanceof Error ? err.message : err);
  }
  return mergeWithDiscovered(curated, discovered);
}

// ── Content + fix steps ───────────────────────────────────────

async function contentStep(
  title: string, blueprint: Blueprint, selectedLinks: SelectedLinks,
  sourceBrief: SourceBrief, strategy: StrategyBrief,
  customInstruction: string | undefined, language: string, authorityLinks: AuthorityLink[], ctx: StepCtx
): Promise<BlogContent> {
  "use step";
  return guarded("content", ctx, () =>
    generateBlogContent(title, blueprint, selectedLinks, sourceBrief, strategy, customInstruction, language || undefined, authorityLinks));
}

async function fixStep(
  title: string, prevContent: BlogContent, blueprint: Blueprint, selectedLinks: SelectedLinks,
  failingChecks: Record<string, boolean>, language: string, brokenUrls: string[], authorityLinks: AuthorityLink[], ctx: StepCtx
): Promise<BlogContent> {
  "use step";
  return guarded("fix", ctx, () =>
    fixBlogContent(title, prevContent, blueprint, selectedLinks, failingChecks, language || undefined, brokenUrls.length > 0 ? brokenUrls : undefined, authorityLinks));
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
): Promise<{ content: BlogContent; brokenUrls: string[]; linkWarnings: string[] }> {
  "use step";
  // Pass 1 — strip URLs not on an approved domain
  const approvedUrls = authorityLinks.map((l) => l.url);
  const { content: enforced, removed: unapproved } = enforceApprovedLinks(content, approvedUrls);
  // Pass 2 — remove genuine 404s (external + internal); 403s pass with a warning
  const { content: scrubbed, removed: broken, warnings: linkWarnings } = await scrubBrokenExternalLinks(enforced);
  // Pass 3 — strip links inside visual blocks
  let out = stripLinksFromVisualBlocks(scrubbed);

  // Keypoint callouts have a hard design width: guarantee the limit here rather
  // than hoping the model counted characters. Whole sentences are kept where
  // possible (shortenKeypoint), and any trim is logged so a prompt that keeps
  // overshooting is visible.
  for (const field of ["keypoint_one", "keypoint_two"] as const) {
    const before = (out[field] ?? "").trim();
    if (before.length > KEYPOINT_MAX_CHARS) {
      const after = shortenKeypoint(before);
      console.warn(`[wf] ${field} was ${before.length} chars (limit ${KEYPOINT_MAX_CHARS}) — trimmed to ${after.length}`);
      out = { ...out, [field]: after };
    }
  }

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

  return { content: out, brokenUrls: [...new Set([...prevBrokenUrls, ...unapproved, ...broken])], linkWarnings };
}

// ── Image prompts + QA ────────────────────────────────────────

async function imagePromptsStep(title: string, content: BlogContent, ctx: StepCtx): Promise<ImagePrompts> {
  "use step";
  return guarded("imagePrompts", ctx, () => generateImagePrompts(title, content));
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

type PublishResult = {
  postId: number; link: string | null; articleHtml: string;
  assembled: { main_content: string; more_content_1: string; more_content_3: string; more_content_4: string };
};

/** Embed the flowchart and strip the IMGSLOT markers — what WordPress receives. */
function assembleForPublish(content: BlogContent) {
  // Embed the flowchart HTML now, so it is part of the post regardless of how
  // image generation goes. IMGSLOT_* markers are placeholders the image step
  // replaces later.
  const embedded = embedFlowchartHtml(content);
  const assembled = {
    main_content:   embedded.main_content.replace("IMGSLOT_MAIN", ""),
    more_content_1: embedded.more_content_1.replace("IMGSLOT_ONE", ""),
    more_content_3: embedded.more_content_3.replace("IMGSLOT_TWO", ""),
    more_content_4: embedded.more_content_4.replace("IMGSLOT_SPLIT", ""),
  };
  const articleHtml = [
    embedded.key_takeaways, assembled.main_content, embedded.keypoint_one, assembled.more_content_1,
    embedded.more_content_2, embedded.quote_1, assembled.more_content_3, embedded.keypoint_two,
    assembled.more_content_4, embedded.quote_2, embedded.more_content_5, embedded.more_content_6, embedded.final_points,
  ].filter(Boolean).join("\n");
  return { embedded, assembled, articleHtml };
}

async function publishStep(
  title: string, content: BlogContent, imagePrompts: ImagePrompts, language: string,
  wpStatus: "draft" | "publish" = "publish"
): Promise<PublishResult> {
  "use step";
  const { embedded, assembled, articleHtml } = assembleForPublish(content);
  console.log(`[wf] flowchart steps: ${embedded.flowchart_steps?.length ?? 0}`);
  // A persistent SiteGround block is not something a retry can fix — the next
  // two attempts hit the same wall and cost ~50s of backoff each. Convert it to
  // FatalError so WDK stops immediately and the operator sees the real cause.
  let post;
  try {
    post = await createWordPressPost(embedded.seo_title || title, embedded, imagePrompts, assembled, null, language || undefined, wpStatus);
  } catch (err) {
    if (err instanceof SiteGroundBlockedError) throw new FatalError(err.message);
    throw err;
  }
  // Extract only JSON-serializable scalars — WDK rejects step return values
  // that contain functions or prototype-inherited methods.
  return {
    postId: typeof post?.id === "number" ? post.id : 0,
    link:   typeof post?.link === "string" ? post.link : null,
    articleHtml,
    assembled,
  };
}

/** An earlier run already created the WordPress post: rebuild the publish result without a second post. */
async function reusePublishedStep(published: { postId: number; link: string | null }, content: BlogContent): Promise<PublishResult> {
  "use step";
  const { assembled, articleHtml } = assembleForPublish(content);
  return { postId: published.postId, link: published.link, articleHtml, assembled };
}

// ── Saved progress (lib/drafts.ts) ─────────────────────────────
// Every stage writes its output to the draft store as it completes; a new
// run for the same item resumes from it. Both steps are best-effort: the
// store must never be the reason a generation fails.

async function loadDraftStep(key: string, signature: string): Promise<GenerationDraft | null> {
  "use step";
  try {
    const { loadDraft } = await import("@/lib/drafts");
    return await loadDraft(key, signature);
  } catch (err) {
    console.warn(`[wf] could not load saved draft (starting clean): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function saveDraftStep(key: string, signature: string, patch: Partial<GenerationDraft>, queueItemId?: string): Promise<void> {
  "use step";
  try {
    const { saveDraft, mirrorDraftOnItem } = await import("@/lib/drafts");
    const { getWorkflowMetadata } = await import("workflow");
    let runId: string | undefined;
    try { runId = getWorkflowMetadata().workflowRunId; } catch { /* not available outside a run */ }
    const draft = await saveDraft(key, { ...patch, signature, ...(queueItemId ? { queueItemId } : {}) }, runId);
    if (queueItemId) await mirrorDraftOnItem(queueItemId, draft);
  } catch (err) {
    console.warn(`[wf] draft save failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Record the published post in the unified post history (shared with the
// scheduler) so manual-route posts also appear in the "recent posts" view
// and can have media added later. Non-fatal — never blocks the workflow.
async function recordHistoryStep(
  postId: number, link: string | null, content: BlogContent, needsReview: boolean,
  source: "manual" | "scheduler" = "manual",
  mediaOutputs?: { audio?: boolean; video?: boolean; podcast?: boolean },
  imagePrompts?: ImagePrompts
): Promise<void> {
  "use step";
  if (!postId) return;
  try {
    const { addPostHistory } = await import("@/lib/storage");
    const { conceptsFromPrompts } = await import("@/lib/imageBrief");
    const imageConcepts = conceptsFromPrompts(imagePrompts);
    await addPostHistory({
      ...(imageConcepts ? { imageConcepts } : {}),
      wpPostId: postId,
      title: content.seo_title || content.focus_keyword || `Post ${postId}`,
      slug: content.slug,
      focusKeyword: content.focus_keyword,
      wpEditUrl: `${process.env.WP_URL}/wp-admin/post.php?post=${postId}&action=edit`,
      wpPostUrl: link,
      source,
      needsReview,
      ...(mediaOutputs ? { mediaOutputs: {
        audio: mediaOutputs.audio === true,
        video: mediaOutputs.video === true,
        podcast: mediaOutputs.podcast === true,
      } } : {}),
    });
  } catch (err) {
    console.warn(`[wf] post-history write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Queue bookkeeping steps (no-ops for browser runs) ─────────

const ITEM_TOTAL_STEPS = 6;

async function itemProgressStep(itemId: string, step: number, label: string): Promise<void> {
  "use step";
  try {
    const { updateQueueItem } = await import("@/lib/storage");
    await updateQueueItem(itemId, { progress: { step, total: ITEM_TOTAL_STEPS, label, updatedAt: new Date().toISOString() } });
  } catch (err) {
    console.warn(`[wf] item progress write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function completeItemStep(
  itemId: string, runLogId: string | undefined, postId: number, link: string | null,
  qaScore: number, qaWarnings: string[]
): Promise<void> {
  "use step";
  const { updateQueueItem, updateRunLog } = await import("@/lib/storage");
  await updateQueueItem(itemId, {
    status: "completed",
    completedAt: new Date().toISOString(),
    progress: null,
    wpPostId: postId,
    wpEditUrl: `${process.env.WP_URL}/wp-admin/post.php?post=${postId}&action=edit`,
    wpPostUrl: link,
    qaScore,
    qaWarnings,
    lastError: null,
  });
  if (runLogId) {
    const { getRunUsage } = await import("@/lib/usage");
    const usage = await getRunUsage(runLogId).catch(() => null);
    await updateRunLog(runLogId, { completedAt: new Date().toISOString(), topicsCompleted: 1, status: "completed", usage });
  }
  console.log(`[wf] queue item ${itemId} completed — WP post ${postId}, QA ${qaScore}/100`);
}

async function failItemStep(itemId: string, runLogId: string | undefined, topic: string, message: string): Promise<void> {
  "use step";
  try {
    const { getQueueItem, updateQueueItem, updateRunLog } = await import("@/lib/storage");
    const { notify } = await import("@/lib/notify");
    const { humaniseError, formatQueueError } = await import("@/lib/errors");
    const { getRunUsage } = await import("@/lib/usage");
    // Plain-English summary + next action for the queue row; the raw text is
    // kept in lastErrorDetail for the "details" view and the alert.
    const human = humaniseError(message);
    const summary = formatQueueError(human);
    const item = await getQueueItem(itemId);
    await updateQueueItem(itemId, {
      status: "failed",
      retryCount: (item?.retryCount ?? 0) + 1,
      lastError: summary,
      lastErrorDetail: message,
      progress: null,
    });
    if (runLogId) {
      const usage = await getRunUsage(runLogId).catch(() => null);
      await updateRunLog(runLogId, { completedAt: new Date().toISOString(), topicsFailed: 1, status: "failed", error: summary, usage });
    }
    await notify(
      `❌ Post generation failed: "${topic}"`,
      `${human.title}\n→ ${human.action}\n\nDetails: ${message.slice(0, 700)}`
    );
  } catch (err) {
    console.warn(`[wf] fail-item bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Start the post-publish media workflow (start() must run inside a step).
// Images ALWAYS generate for queue-driven posts — the cron no longer renders
// them inline. For a needs-review draft only images run: video would publish
// the WP post as a side effect, which a draft awaiting review must not do.
async function startMediaStep(
  input: GeneratePostInput,
  published: Awaited<ReturnType<typeof publishStep>>,
  content: BlogContent,
  needsReview: boolean,
  imagePrompts: ImagePrompts
): Promise<void> {
  "use step";
  try {
    const { start } = await import("workflow/api");
    const { generateMediaWorkflow } = await import("@/lib/workflows/generateMedia");
    const outputs = needsReview
      ? { audio: false, video: false, podcast: false, images: true }
      : {
          audio:   input.mediaOutputs?.audio   === true,
          video:   input.mediaOutputs?.video   === true,
          podcast: input.mediaOutputs?.podcast === true,
          images:  true,
        };
    const run = await start(generateMediaWorkflow, [{
      postId: published.postId,
      title: content.seo_title || input.title,
      focusKeyword: content.focus_keyword ?? "",
      secondaryKeywords: content.secondary_keywords ?? [],
      summary: content.meta_description || content.excerpt || "",
      blogUrl: published.link,
      language: input.language || null,
      content: {
        main_content:   published.assembled.main_content,
        more_content_1: published.assembled.more_content_1,
        more_content_2: content.more_content_2 ?? "",
        more_content_3: published.assembled.more_content_3,
        more_content_4: published.assembled.more_content_4,
        more_content_5: content.more_content_5 ?? "",
        more_content_6: content.more_content_6 ?? "",
        final_points:   content.final_points ?? "",
        keypoint_one:   content.keypoint_one ?? "",
        keypoint_two:   content.keypoint_two ?? "",
        quote_1:        content.quote_1 ?? "",
        quote_2:        content.quote_2 ?? "",
        key_takeaways:  content.key_takeaways ?? "",
      },
      outputs,
      podcastLength: input.podcastLength ?? 30,
      // Render the briefs this run wrote and QA'd, rather than briefing again.
      imagePrompts,
      queueItemId: input.queueItemId,
    }]);
    if (input.queueItemId) {
      const { updateQueueItem } = await import("@/lib/storage");
      await updateQueueItem(input.queueItemId, { mediaRunId: run.runId, mediaStatus: "running", mediaDone: {} });
    }
    console.log(`[wf] media workflow started for post ${published.postId} (run ${run.runId}) — images:true audio:${outputs.audio} video:${outputs.video} podcast:${outputs.podcast}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wf] could not start media workflow for post ${published.postId} — post has NO images until run from /media: ${msg}`);
    if (input.queueItemId) {
      try {
        const { updateQueueItem } = await import("@/lib/storage");
        await updateQueueItem(input.queueItemId, { mediaStatus: "failed" });
      } catch { /* item bookkeeping is best-effort */ }
    }
    const { notify } = await import("@/lib/notify");
    await notify(`⚠️ Media workflow failed to start for post ${published.postId}`, `${msg}\nGenerate images from /media.`);
  }
}

// ── Patient publish ───────────────────────────────────────────
// SiteGround's Anti-Bot AI challenges Vercel's egress IPs intermittently, and
// it does so most often on the POST that creates the post — the very last
// step, after 10–15 minutes of model work. Failing the run there throws that
// work away and a "Retry now" regenerates the whole article. The block
// usually clears within minutes (writes succeeded at 14:00 and 16:36 on
// 2026-09-07; the 16:50 one was challenged four times in a row), so wait it
// out with DURABLE sleeps and try again — the article is already checkpointed.
// Runs in the workflow body (sleep is a workflow primitive), so no Node APIs.

const PUBLISH_RETRY_WAITS = ["3m", "5m", "8m", "12m", "15m"] as const; // ≈ 43 minutes in total

/** True when the text the image briefs are anchored to changed in a fix pass. */
function imageBriefInputsChanged(prev: BlogContent, next: BlogContent): boolean {
  const keys: Array<keyof BlogContent> = ["keypoint_one", "keypoint_two", "quote_2", "key_takeaways", "seo_title", "focus_keyword"];
  return keys.some((k) => (prev[k] ?? "") !== (next[k] ?? ""));
}

function isWordPressBlocked(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return humaniseError(msg).kind === "wordpress_blocked";
}

async function publishWithPatience(
  input: GeneratePostInput, title: string, content: BlogContent, imagePrompts: ImagePrompts,
  wpStatus: "draft" | "publish"
): Promise<Awaited<ReturnType<typeof publishStep>>> {
  for (let i = 0; ; i++) {
    try {
      return await publishStep(title, content, imagePrompts, input.language, wpStatus);
    } catch (err) {
      if (!isWordPressBlocked(err) || i >= PUBLISH_RETRY_WAITS.length) throw err;
      const wait = PUBLISH_RETRY_WAITS[i];
      const note = `WordPress is blocking Vercel right now (SiteGround anti-bot). The article is written and saved; publishing again in ${wait.replace("m", " min")} (${i + 1} of ${PUBLISH_RETRY_WAITS.length})`;
      console.warn(`[wf] publish blocked by SiteGround — waiting ${wait} before retry ${i + 1}/${PUBLISH_RETRY_WAITS.length}`);
      await emit({ type: "progress", message: note });
      if (input.queueItemId) await itemProgressStep(input.queueItemId, 5, note);
      await sleep(wait);
    }
  }
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

  // Serializable step context: which run log the LLM usage belongs to.
  const ctx: StepCtx = { runLogId: input.runLogId };

  // Saved progress: keyed by queue item, valid only while the item's inputs
  // are unchanged (signature). Every stage below saves as it completes, and a
  // new run for the same item picks up from whatever is stored instead of
  // paying for the model calls again.
  const draftKey = draftKeyFor({ queueItemId: input.queueItemId, title: input.title, customInstruction: input.customInstruction, mode: input.mode, sourceText: input.sourceText });
  const signature = inputSignature(input);
  const save = (patch: Partial<GenerationDraft>) => saveDraftStep(draftKey, signature, patch, input.queueItemId);

  try {
  console.log("[wf] start — hasTopic:", input.hasTopic, "mode:", input.mode, "lang:", input.language, "queueItem:", input.queueItemId ?? "none");
  const draft = await loadDraftStep(draftKey, signature);
  if (draft) {
    console.log(`[wf] resuming from saved draft — stage: ${draft.stage} (saved ${draft.updatedAt}, runs so far: ${draft.runIds.length})`);
    await emit({ type: "progress", message: `Resuming from the saved draft (${DRAFT_STAGE_LABELS[draft.stage] ?? draft.stage}) — nothing already generated is redone` });
  }
  await emit({ type: "progress", message: "Researching and planning…" });
  if (input.queueItemId) await itemProgressStep(input.queueItemId, 1, draft ? "Resuming from the saved draft…" : "Researching the search landscape…");

  // Title / topic
  let title = input.title;
  let strategyTopic = input.title;
  if (!input.hasTopic) {
    if (draft?.title) {
      title = draft.title;
      strategyTopic = draft.strategyTopic ?? draft.title;
      console.log("[wf] title from saved draft:", title);
    } else {
      console.log("[wf] step: deriveTitle");
      const derived = await deriveTitleStep(input.customInstruction ?? "", input.primary_country, ctx);
      title = derived.title;
      strategyTopic = derived.topic;
      console.log("[wf] deriveTitle done — title:", title);
    }
  }

  const fileSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  if (!draft) await save({ title, strategyTopic, fileSlug, stage: "started" });

  // Setup (steps auto-retry transient errors; research/authority degrade gracefully)
  let research: ResearchBrief | null;
  if (draft && draft.research !== undefined) {
    research = draft.research;
  } else {
    console.log("[wf] step: research");
    research = await researchStep(title, input.primary_country, input.customInstruction, ctx);
  }
  if (!research) {
    console.warn("[wf] research returned null — article will be written without live SERP data");
    await emit({ type: "progress", message: "Live research unavailable — writing from domain knowledge only" });
  }
  console.log("[wf] step: selectLinks");
  const selectedLinks = draft?.selectedLinks ?? await selectLinksStep(title, input.language);
  console.log("[wf] step: sourceBrief");
  const sourceBrief = draft?.sourceBrief ?? await sourceBriefStep(input.mode, title, input.sourceText, ctx);
  if (!draft?.sourceBrief) await save({ research, selectedLinks, sourceBrief });

  let strategy = draft?.strategy;
  if (!strategy) {
    console.log("[wf] step: strategy");
    strategy = await strategyStep(input, strategyTopic, research);
    await save({ strategy });
  }
  await emit({ type: "progress", message: `Strategy ready — keyword "${strategy.keyword_model.primary_keyword}"` });
  if (input.queueItemId) await itemProgressStep(input.queueItemId, 2, "Planning the article blueprint…");

  let blueprint = draft?.blueprint;
  if (!blueprint) {
    console.log("[wf] step: blueprint");
    blueprint = await blueprintStep(title, selectedLinks, sourceBrief, strategy, input.customInstruction, input.language, ctx);
  }
  let authorityLinks = draft?.authorityLinks;
  if (!authorityLinks) {
    console.log("[wf] step: authorityLinks");
    authorityLinks = await authorityLinksStep(title, strategy, ctx);
    await save({ blueprint, authorityLinks, stage: "planned" });
  }
  await emit({ type: "progress", message: "Writing the article…" });
  if (input.queueItemId) await itemProgressStep(input.queueItemId, 3, "Writing the article…");

  // ── Article + QA (or resume straight to publish) ──────────────
  type Outcome = { content: BlogContent; imagePrompts: ImagePrompts; qa: DraftQa; needsReview: boolean };
  let outcome: Outcome | null = null;

  if (draft?.content && draft.imagePrompts && draft.qa && draft.qa.decision !== "retry") {
    console.log(`[wf] article and QA from saved draft (decision: ${draft.qa.decision}) — going straight to publish`);
    outcome = { content: draft.content, imagePrompts: draft.imagePrompts, qa: draft.qa, needsReview: draft.qa.decision === "publish_draft" };
  } else {
    let prevContent: BlogContent | null = null;
    let prevImagePrompts: ImagePrompts | null = draft?.imagePrompts ?? null;
    let prevChecks: Record<string, boolean> | null = null;
    let prevBrokenUrls: string[] = draft?.prevBrokenUrls ?? [];
    const resumeContent: BlogContent | null = draft?.content ?? null;

    for (let attempt = 1; attempt <= MAX_QA; attempt++) {
      let content: BlogContent;
      if (attempt === 1 && resumeContent) {
        console.log("[wf] article from saved draft — re-running QA on it");
        content = resumeContent;
      } else if (attempt === 1) {
        console.log("[wf] step: content attempt", attempt);
        content = await contentStep(title, blueprint, selectedLinks, sourceBrief, strategy, input.customInstruction, input.language, authorityLinks, ctx);
      } else {
        console.log("[wf] step: fix attempt", attempt);
        content = await fixStep(title, prevContent!, blueprint, selectedLinks, prevChecks!, input.language, prevBrokenUrls, authorityLinks, ctx);
      }
      console.log("[wf] step: scrub attempt", attempt);
      const scrubbed = await scrubStep(content, authorityLinks, prevBrokenUrls);
      content = scrubbed.content;
      prevBrokenUrls = scrubbed.brokenUrls;
      if (scrubbed.linkWarnings.length > 0) {
        console.warn("[wf] links returned 403 (kept with warning):", scrubbed.linkWarnings.join(", "));
        await emit({ type: "progress", message: `${scrubbed.linkWarnings.length} link(s) returned 403 and were kept with a warning` });
      }

      // Re-brief the images only when there are none yet, the alt text failed
      // QA, or the fix pass changed the text the briefs are anchored to.
      const needNewImagePrompts = !prevImagePrompts
        || prevChecks?.image_alt_text_exists === false
        || (prevContent !== null && imageBriefInputsChanged(prevContent, content));
      console.log("[wf] step: imagePrompts attempt", attempt, "regen:", needNewImagePrompts);
      const imagePrompts: ImagePrompts = needNewImagePrompts ? await imagePromptsStep(title, content, ctx) : prevImagePrompts!;
      console.log("[wf] step: qa attempt", attempt);
      if (input.queueItemId) await itemProgressStep(input.queueItemId, 4, attempt === 1 ? "Running quality checks…" : `Quality checks (attempt ${attempt} of ${MAX_QA})…`);
      const { qa, readMins } = await qaStep(content, imagePrompts, title);
      content = { ...content, read_mins: readMins };
      console.log("[wf] qa result — status:", qa.status, "score:", qa.score);

      prevContent = content;
      prevImagePrompts = imagePrompts;
      prevChecks = qa.checks;

      const summary: DraftQa = {
        status: qa.status, score: qa.score, warnings: qa.warnings, blocking_issues: qa.blocking_issues,
        wordCount: qa.wordCount, readMins, attempt, decision: "retry",
      };

      if (qa.status === "fail") {
        if (attempt < MAX_QA) {
          await save({ content, imagePrompts, prevBrokenUrls, qa: summary, stage: "written" });
          await emit({ type: "qa_retry", attempt: attempt + 1, max: MAX_QA });
          continue;
        }
        // EXHAUSTED — save as a WordPress draft (failed QA should not go live).
        summary.decision = "publish_draft";
        await save({ content, imagePrompts, prevBrokenUrls, qa: summary, stage: "qa_exhausted" });
        outcome = { content, imagePrompts, qa: summary, needsReview: true };
        break;
      }

      // First pass with retryable warnings → one targeted fix pass
      if (attempt === 1) {
        const retryable = RETRYABLE_WARNING_CHECKS.filter((k) => qa.checks[k] === false);
        if (retryable.length > 0) {
          await save({ content, imagePrompts, prevBrokenUrls, qa: summary, stage: "written" });
          await emit({ type: "qa_retry", attempt: attempt + 1, max: MAX_QA });
          continue;
        }
      }

      summary.decision = "publish";
      await save({ content, imagePrompts, prevBrokenUrls, qa: summary, stage: "qa_passed" });
      outcome = { content, imagePrompts, qa: summary, needsReview: false };
      break;
    }
    // Unreachable — the loop always sets an outcome. Fatal so it surfaces if logic changes.
    if (!outcome) throw new FatalError("QA loop exited without an outcome");
  }

  const { content, imagePrompts, qa, needsReview } = outcome;

  // ── Publish ────────────────────────────────────────────────────
  const wpStatus: "draft" | "publish" = needsReview ? "draft" : "publish";
  console.log(`[wf] step: publish (${needsReview ? "qa-exhausted" : "pass"})`);
  if (input.queueItemId) await itemProgressStep(input.queueItemId, 5, needsReview ? "Saving draft to WordPress (needs review)…" : "Publishing draft to WordPress…");
  let published: PublishResult;
  if (draft?.published?.postId) {
    console.log(`[wf] WordPress post ${draft.published.postId} was already created by an earlier run — reusing it`);
    published = await reusePublishedStep(draft.published, content);
  } else {
    published = await publishWithPatience(input, title, content, imagePrompts, wpStatus);
    await save({ published: { postId: published.postId, link: published.link, status: wpStatus, needsReview }, stage: "published" });
  }

  await recordHistoryStep(published.postId, published.link, content, needsReview,
    input.queueItemId ? "scheduler" : "manual", input.mediaOutputs, imagePrompts);
  if (input.queueItemId) {
    await completeItemStep(input.queueItemId, input.runLogId, published.postId, published.link, qa.score, needsReview ? qa.blocking_issues : qa.warnings);
    await startMediaStep(input, published, content, needsReview, imagePrompts);
  }
  await save({ stage: "completed" });
  await emit(buildDoneEvent({
    published, content, imagePrompts, fileSlug, imageModel: input.imageModel,
    readMins: qa.readMins, wordCount: qa.wordCount, language: input.language,
    needsReview,
    ...(needsReview
      ? { failingChecks: qa.blocking_issues }
      : { qa: { status: qa.status, score: qa.score, warnings: qa.warnings } }),
  }));
  await closeStream();
  console.log(`[wf] done${needsReview ? " (needs review)" : ""}, postId:`, published.postId);
  return { postId: published.postId, needsReview };
  } catch (err) {
    // A step failed after exhausting WDK's retries (or a fatal error like a bad
    // API key). Log the real cause (visible in Vercel function logs), tell the
    // client, close the stream so it never hangs, then re-throw so the run is
    // marked failed in observability. Whatever was generated is in the draft
    // store — the next run resumes from it.
    const errName = err instanceof Error ? err.constructor.name : typeof err;
    const errMsg  = err instanceof Error
      ? err.message
      : typeof err === "string"
      ? err
      : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
    console.error(`[generatePost] Workflow failed — ${errName}: ${errMsg}`, err);
    const message = errMsg || "Generation failed unexpectedly. Please try again.";
    await save({ lastError: message });
    if (input.queueItemId) {
      await failItemStep(input.queueItemId, input.runLogId, input.title || input.customInstruction?.slice(0, 60) || "untitled", message);
    }
    await emit({ type: "error", message });
    await closeStream();
    throw err;
  }
}
