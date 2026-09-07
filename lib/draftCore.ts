/**
 * lib/draftCore.ts
 * ─────────────────────────────────────────────────────────────
 * Pure helpers for the generation draft store (no Node APIs, no SDKs), so the
 * workflow BODY can compute draft keys and the dashboard can render a saved
 * article. The I/O lives in lib/drafts.ts and must only be reached from steps
 * and routes.
 */

import type { BlogContent } from "./wordpress";

export type DraftStage =
  | "started"      // title resolved, nothing generated yet
  | "planned"      // research, strategy, blueprint, authority links done
  | "written"      // article written (QA still iterating)
  | "qa_passed"    // article written and QA passed — only the publish is left
  | "qa_exhausted" // article written, QA never passed — to be saved as a WP draft
  | "published"    // WordPress post created
  | "completed";   // run finished (history + media hand-off done)

export const DRAFT_STAGE_LABELS: Record<DraftStage, string> = {
  started:      "started",
  planned:      "planned (strategy and blueprint ready)",
  written:      "article written, QA in progress",
  qa_passed:    "article written and QA passed",
  qa_exhausted: "article written, QA needs review",
  published:    "published to WordPress",
  completed:    "completed",
};

/** Small, fast, deterministic string hash (hex). Not cryptographic. */
export function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// Field separator that cannot occur in user text.
const SEP = String.fromCharCode(1);

export interface DraftKeyInput {
  queueItemId?: string;
  title?: string;
  customInstruction?: string;
  mode?: string;
  sourceText?: string;
}

/** Queue items are keyed by id; anything else by a hash of what was asked for. */
export function draftKeyFor(input: DraftKeyInput): string {
  if (input.queueItemId) return `item:${input.queueItemId}`;
  return `manual:${djb2([input.mode ?? "", input.title ?? "", input.customInstruction ?? "", (input.sourceText ?? "").slice(0, 2000)].join(SEP))}`;
}

export interface SignatureInput {
  hasTopic?: boolean;
  title?: string;
  mode?: string;
  sourceText?: string;
  audience?: string;
  primary_country?: string;
  secondary_countries?: string;
  priority_service?: string;
  language?: string;
  customInstruction?: string;
}

/**
 * Everything that changes what the article should be. A saved draft is only
 * resumed when the signature matches, so editing a queued item's topic or
 * instructions starts a clean generation.
 */
export function inputSignature(i: SignatureInput): string {
  const parts = [
    i.hasTopic ? "topic" : "prompt", i.title, i.mode, i.sourceText, i.audience, i.primary_country,
    i.secondary_countries, i.priority_service, i.language, i.customInstruction,
  ].map((v) => String(v ?? "").trim());
  return djb2(parts.join(SEP));
}

/** Strip the IMGSLOT_* markers the image step replaces at publish time. */
function stripSlots(html: string): string {
  return html.replace(/IMGSLOT_(MAIN|ONE|TWO|SPLIT)/g, "");
}

/**
 * The article as one block of HTML in page order — what a person pastes into
 * WordPress by hand when the site cannot be reached. Plain-text fields
 * (pull-outs, quotes) are wrapped so nothing is lost.
 */
export function assembleArticleHtml(content: Partial<BlogContent>): string {
  const wrapPlain = (text: string | undefined, tag: "blockquote" | "p", cls: string) =>
    text?.trim() ? `<${tag} class="${cls}">${text.trim()}</${tag}>` : "";
  const html = (field: keyof BlogContent) => {
    const v = content[field];
    return typeof v === "string" ? stripSlots(v).trim() : "";
  };
  const parts = [
    html("key_takeaways"),
    html("main_content"),
    wrapPlain(content.keypoint_one, "p", "aston-keypoint"),
    html("more_content_1"),
    html("more_content_2"),
    wrapPlain(content.quote_1, "blockquote", "aston-quote"),
    html("more_content_3"),
    wrapPlain(content.keypoint_two, "p", "aston-keypoint"),
    html("more_content_4"),
    wrapPlain(content.quote_2, "blockquote", "aston-quote"),
    html("more_content_5"),
    html("final_points"),
    html("more_content_6"),
  ];
  return parts.filter(Boolean).join("\n\n");
}
