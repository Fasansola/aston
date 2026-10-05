/**
 * lib/qaChecks.ts
 * ─────────────────────────────────────────────────────────────
 * Tiny constants module shared by the QA loop and the content fixer.
 *
 * Lives on its own (rather than in lib/openai.ts) because the workflow
 * orchestrator reads IMAGE_QA_CHECKS in the workflow body itself. Importing
 * it from lib/openai.ts dragged the entire OpenAI SDK into the workflow
 * bundle, which only needs this three-element array.
 */

/** QA checks that relate to images — if only these fail, content doesn't need fixing. */
export const IMAGE_QA_CHECKS = ["featured_image_exists", "section_images_exist", "image_alt_text_exists"];

/** QA checks whose only remedy is rewriting the title. */
export const TITLE_QA_CHECKS = ["seo_title_exists", "focus_keyword_in_title", "seo_title_length_ok", "seo_title_focused", "no_dashes_in_title"];

/**
 * The checks a fix pass may act on when the operator typed the title: the
 * title ones are marked as passed, so the model is never asked to rewrite it
 * and a title-only warning never costs a retry. Pure.
 */
export function withoutTitleChecks(checks: Record<string, boolean>): Record<string, boolean> {
  const out = { ...checks };
  for (const k of TITLE_QA_CHECKS) if (k in out) out[k] = true;
  return out;
}
