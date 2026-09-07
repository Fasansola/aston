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
