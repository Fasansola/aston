/**
 * lib/drafts.ts
 * ─────────────────────────────────────────────────────────────
 * Saved generation progress ("drafts"), so a failed or interrupted run never
 * loses what it already paid for.
 *
 * Inside one Workflow run the DevKit checkpoints every step, but a run that
 * ends in a FatalError (a SiteGround block on the final publish, a quota
 * error, a watchdog re-queue) is dead, and "Retry now" starts a NEW run that
 * used to regenerate everything: research, strategy, blueprint, a 10-minute
 * article, QA passes, image briefs. On 2026-09-07 that happened twice in a
 * row for one post.
 *
 * Now every stage writes its output here as it completes, keyed by queue
 * item, and a new run for the same item resumes from whatever is stored:
 * an article that passed QA goes straight to publish; a post that was
 * already created is reused instead of duplicated. The dashboard can open
 * the saved article (GET /api/queue/draft?id=…&format=html) so it can be
 * pasted into WordPress by hand if the site stays unreachable.
 *
 * Node-side module (Redis via lib/storage.ts): import it from steps and
 * routes only, never from a workflow body. Keys: aston:draft:<key>, kept for
 * 14 days.
 */

import { kget, kset, kexpire, updateQueueItem } from "./storage";
import type { DraftStage } from "./draftCore";
import type { BlogContent, Blueprint, ImagePrompts } from "./wordpress";
import type { SelectedLinks } from "./links";
import type { SourceBrief } from "./source";
import type { StrategyBrief } from "./strategy";
import type { AuthorityLink } from "./authorityLinks";
import type { ResearchBrief } from "./research";

export interface DraftQa {
  status: string;
  score: number;
  warnings: string[];
  blocking_issues: string[];
  wordCount: number;
  readMins: string;
  attempt: number;
  /** What the QA loop decided after this attempt. "retry" means keep iterating. */
  decision: "retry" | "publish" | "publish_draft";
}

export interface GenerationDraft {
  key: string;
  /** Hash of the inputs; a draft is only resumed when it matches. */
  signature: string;
  queueItemId?: string;
  createdAt: string;
  updatedAt: string;
  stage: DraftStage;
  runIds: string[];
  title?: string;
  strategyTopic?: string;
  fileSlug?: string;
  research?: ResearchBrief | null;
  selectedLinks?: SelectedLinks;
  sourceBrief?: SourceBrief;
  strategy?: StrategyBrief;
  blueprint?: Blueprint;
  authorityLinks?: AuthorityLink[];
  /** Latest article (after link scrubbing and QA read-time). */
  content?: BlogContent;
  imagePrompts?: ImagePrompts;
  prevBrokenUrls?: string[];
  qa?: DraftQa;
  published?: { postId: number; link: string | null; status: "draft" | "publish"; needsReview: boolean };
  lastError?: string;
  failedAt?: string;
}

const KEY = (key: string) => `aston:draft:${key}`;
const DRAFT_TTL_SECONDS = 14 * 24 * 3600;

export async function loadDraft(key: string, signature?: string): Promise<GenerationDraft | null> {
  const d = await kget<GenerationDraft | null>(KEY(key), null);
  if (!d || typeof d !== "object" || !d.key) return null;
  if (signature && d.signature !== signature) {
    console.log(`[drafts] ignoring saved draft for ${key}: inputs changed since it was written`);
    return null;
  }
  return d;
}

/**
 * Merge a patch into the saved draft. When the stored signature differs from
 * the patch's (the item was edited), the old draft is discarded rather than
 * merged, so stale content can never leak into a new generation.
 */
export async function saveDraft(
  key: string,
  patch: Partial<GenerationDraft> & { signature: string },
  runId?: string
): Promise<GenerationDraft> {
  const now = new Date().toISOString();
  const existing = await kget<GenerationDraft | null>(KEY(key), null);
  const base: GenerationDraft = existing && existing.key && existing.signature === patch.signature
    ? existing
    : { key, signature: patch.signature, createdAt: now, updatedAt: now, stage: "started", runIds: [] };
  const runIds = runId && !base.runIds.includes(runId) ? [...base.runIds, runId] : base.runIds;
  const next: GenerationDraft = {
    ...base,
    ...patch,
    key,
    runIds,
    updatedAt: now,
    ...(patch.lastError ? { failedAt: now } : {}),
  };
  await kset(KEY(key), next);
  try { await kexpire(KEY(key), DRAFT_TTL_SECONDS); } catch { /* file adapter has no TTL */ }
  return next;
}

export async function deleteDraft(key: string): Promise<void> {
  await kset(KEY(key), null);
}

/** Mirror the draft's stage onto the queue item so the dashboard can show it without a second fetch. */
export async function mirrorDraftOnItem(itemId: string, draft: GenerationDraft | null): Promise<void> {
  await updateQueueItem(itemId, {
    draftKey: draft?.key ?? null,
    draftStage: draft?.stage ?? null,
    draftUpdatedAt: draft?.updatedAt ?? null,
  });
}
