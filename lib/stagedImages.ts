/**
 * lib/stagedImages.ts
 * ─────────────────────────────────────────────────────────────
 * Keys for the S3 staging copies of article images (app/api/generate-images).
 * A staged copy lets a retry after a blocked WordPress upload reuse pictures
 * it already paid for.
 */

import { createHash } from "node:crypto";

/**
 * S3 key of the staged copy of one image. It includes a hash of the model and
 * prompt, so only a retry of the SAME brief reuses it. Until 2026-10-05 the
 * key was just post + slot, so "Add media → Article images" on an existing
 * post wrote new briefs and then re-uploaded the post's original pictures
 * (post 71682: all four reused, nothing generated).
 */
export function stagedImageKey(postId: number, slot: string, prompt: string, model: string): string {
  const hash = createHash("sha256").update(`${model}\n${prompt.trim()}`).digest("hex").slice(0, 16);
  return `article-images/${postId}/${slot}-${hash}.png`;
}
