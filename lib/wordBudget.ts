/**
 * lib/wordBudget.ts
 * ─────────────────────────────────────────────────────────────
 * The article length rule, in one place. Pure and Node-free (QA and the
 * workflow body import it).
 *
 * Client rule (2026-10-05): every post is 2,000 to 2,400 words, nothing more
 * and nothing less, whatever a topic's custom brief says. Before this the
 * default target was 3,500 words with ~600–700 words per section, and a word
 * range inside a custom brief silently replaced it — posts ranged from
 * ~2,200 to ~4,800 words.
 *
 * "Words" means what a reader sees in the article: key takeaways, the
 * introduction, the five body sections, keypoints, quotes, the FAQ, the final
 * points and the flowchart steps. The excerpt and SEO fields are not counted.
 */

import type { BlogContent } from "./wordpress";

export const ARTICLE_MIN_WORDS = 2000;
export const ARTICLE_MAX_WORDS = 2400;
/** Aim for the middle so a normal overshoot either way still lands in range. */
export const ARTICLE_TARGET_WORDS = 2200;

/** Introduction (main_content). */
export const INTRO_WORDS = { min: 280, max: 330 } as const;

/**
 * Per-section targets. With the intro (~300), takeaways (~60), keypoints and
 * quotes (~90), FAQ (~180), final points (~45) and flowchart (~60) they sum to
 * ~2,200.
 */
export const SECTION_WORD_TARGETS: Record<string, number> = {
  more_content_1: 320,
  more_content_2: 320,
  more_content_3: 320,
  more_content_4: 220,   // Aston VIP's role
  more_content_6: 290,
};

/** H4 subsections per body section. More than this at ~300 words reads as a checklist. */
export const MAX_H4_PER_SECTION = 3;

/** FAQ: questions and the answer length the budget assumes. */
export const FAQ_QUESTION_COUNT = 5;
export const FAQ_ANSWER_MAX_WORDS = 40;

const COUNTED_FIELDS = [
  "key_takeaways", "main_content", "keypoint_one", "more_content_1", "more_content_2", "quote_1",
  "more_content_3", "keypoint_two", "more_content_4", "quote_2", "more_content_5", "more_content_6", "final_points",
] as const;

/** Fields a length fix may grow or shrink (the prose sections). */
const ADJUSTABLE_FIELDS = ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_6"] as const;

export function countWords(html: string | null | undefined): number {
  const text = (html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/\[FLOWCHART_IMG\]|IMGSLOT_[A-Z]+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.split(" ").length : 0;
}

/** Words a reader sees in the article (see the file header for what counts). */
export function articleWordCount(content: Partial<BlogContent>): number {
  const rec = content as Record<string, unknown>;
  let total = 0;
  for (const f of COUNTED_FIELDS) total += countWords(typeof rec[f] === "string" ? (rec[f] as string) : "");
  for (const step of content.flowchart_steps ?? []) total += countWords(`${step?.title ?? ""} ${step?.detail ?? ""}`);
  return total;
}

export function isWordCountInRange(words: number): boolean {
  return words >= ARTICLE_MIN_WORDS && words <= ARTICLE_MAX_WORDS;
}

export interface WordCountPlan {
  total: number;
  direction: "trim" | "expand";
  /** Fields to rewrite, each with its current and target word count. */
  fields: Array<{ field: string; current: number; target: number }>;
}

/**
 * When the article is out of range, how to bring it back to the target:
 * the difference is spread over the prose sections in proportion to their
 * size (a trim takes most from the longest sections). Null when in range.
 */
export function wordCountPlan(content: Partial<BlogContent>): WordCountPlan | null {
  const total = articleWordCount(content);
  if (isWordCountInRange(total)) return null;
  const delta = ARTICLE_TARGET_WORDS - total;            // + expand, − trim
  const rec = content as Record<string, unknown>;
  const sizes = ADJUSTABLE_FIELDS.map((field) => ({ field, current: countWords(rec[field] as string) }));
  const sum = sizes.reduce((n, s) => n + s.current, 0) || 1;
  const fields = sizes
    .map(({ field, current }) => {
      let target = Math.round(current + (delta * current) / sum);
      if (field === "main_content") target = Math.min(Math.max(target, INTRO_WORDS.min), INTRO_WORDS.max);
      return { field, current, target: Math.max(target, 0) };
    })
    .filter((f) => Math.abs(f.target - f.current) >= 15);
  return { total, direction: delta > 0 ? "expand" : "trim", fields };
}
