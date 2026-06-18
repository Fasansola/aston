/**
 * app/api/generate-images/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-images
 *
 * Second-phase of the split pipeline:
 *   1. Builds the on-brand HTML step diagram from flowchartSteps
 *   2. Generates the four article images (kp1, kp2, split, featured)
 *   3. Uploads all four images to WordPress media library
 *   4. Patches the post: attaches image IDs + featured image
 *   5. Replaces [FLOWCHART_IMG] placeholder in content fields with the HTML diagram
 *
 * SSE event shapes:
 *   { type: "progress", message: string }
 *   { type: "done",     imageIds: { keypointOneImg, keypointTwoImg, postSplitImg, featuredImg } }
 *   { type: "error",    message: string }
 *
 * Body: {
 *   postId:            number
 *   fileSlug:          string
 *   imageModel:        "imagen-4" | "gpt-image-2"
 *   flowchartSteps?: FlowchartStep[]  — ordered process steps; skipped if empty
 *   imagePrompts: { ... }
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateImage, type ImageModel } from "@/lib/openai";
import {
  uploadImageToWordPress,
  updateWordPressPostImages,
  buildFlowchartHtml,
  patchWordPressContentField,
  type FlowchartStep,
} from "@/lib/wordpress";
import axios from "axios";

// gpt-image-2 reasoning can take minutes per image; allow headroom for the
// four parallel generations plus a retry without hitting the wall.
export const maxDuration = 600;

// ACF field names that may contain the [FLOWCHART_IMG] placeholder
const FLOWCHART_FIELDS: Array<{ acf: string }> = [
  { acf: "more_content_1" },
  { acf: "more_content_2" },
  { acf: "more_content_3" },
  { acf: "more_content_6" },
];

const WP_URL          = process.env.WP_URL!;
const WP_USERNAME     = process.env.WP_USERNAME!;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;

/**
 * Fetches the current ACF field values for the post so we can locate
 * and replace the [FLOWCHART_IMG] placeholder in the right field.
 */
async function fetchPostAcf(postId: number): Promise<Record<string, string>> {
  const { data } = await axios.get(
    `${WP_URL}/wp-json/wp/v2/posts/${postId}?context=edit`,
    { auth: { username: WP_USERNAME, password: WP_APP_PASSWORD }, timeout: 15_000 }
  );
  return (data.acf ?? {}) as Record<string, string>;
}

async function generateImageWithRetry(
  prompt: string,
  model: ImageModel,
  label: string,
  maxAttempts = 2
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateImage(prompt, model);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[generate-images] Image "${label}" failed (attempt ${attempt}/${maxAttempts}): ${msg}`);
    }
  }
  throw new Error(`Image "${label}" failed after ${maxAttempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const {
    postId,
    fileSlug,
    imageModel: bodyImageModel,
    flowchartSteps,
    imagePrompts,
  } = body as {
    postId?: number;
    fileSlug?: string;
    imageModel?: string;
    flowchartSteps?: FlowchartStep[];
    imagePrompts?: {
      keypoint_one_img_prompt: string;
      keypoint_one_img_alt: string;
      keypoint_two_img_prompt: string;
      keypoint_two_img_alt: string;
      post_split_img_prompt: string;
      post_split_img_alt: string;
      featured_img_prompt: string;
      featured_img_alt: string;
    };
  };

  if (!postId || typeof postId !== "number") {
    return NextResponse.json({ error: "postId is required." }, { status: 400 });
  }
  if (!fileSlug || !imagePrompts) {
    return NextResponse.json({ error: "fileSlug and imagePrompts are required." }, { status: 400 });
  }

  const imageModel: ImageModel =
    bodyImageModel === "gpt-image-2" ? "gpt-image-2" : "imagen-4";

  const encoder = new TextEncoder();
  const stream  = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = stream.writable.getWriter();

  const send = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});

  (async () => {
    try {
      // ── Step 1: Build the on-brand HTML step diagram ────────
      // No image / third-party renderer — this is styled HTML embedded directly
      // into the article where the [FLOWCHART_IMG] placeholder sits.
      let flowchartImgTag = "";
      if (flowchartSteps && flowchartSteps.length > 0) {
        flowchartImgTag = buildFlowchartHtml(flowchartSteps);
        console.log(`[generate-images] Built HTML flowchart with ${flowchartSteps.length} steps`);
      }

      // ── Step 2: Generate 4 article images in parallel ───────
      await send({ type: "progress", message: `Generating 4 images with ${imageModel}…` });
      console.log(`[generate-images] Generating images for post ${postId} with ${imageModel}`);

      const [kp1Buf, kp2Buf, splitBuf, featBuf] = await Promise.all([
        generateImageWithRetry(imagePrompts.keypoint_one_img_prompt, imageModel, "kp1"),
        generateImageWithRetry(imagePrompts.keypoint_two_img_prompt, imageModel, "kp2"),
        generateImageWithRetry(imagePrompts.post_split_img_prompt,   imageModel, "split"),
        generateImageWithRetry(imagePrompts.featured_img_prompt,     imageModel, "featured"),
      ]);

      // ── Step 3: Upload article images ───────────────────────
      await send({ type: "progress", message: "Uploading images to WordPress…" });

      const uploadResults = await Promise.allSettled([
        uploadImageToWordPress(kp1Buf,   `${fileSlug}-kp1.png`,      imagePrompts.keypoint_one_img_alt),
        uploadImageToWordPress(kp2Buf,   `${fileSlug}-kp2.png`,      imagePrompts.keypoint_two_img_alt),
        uploadImageToWordPress(splitBuf, `${fileSlug}-split.png`,    imagePrompts.post_split_img_alt),
        uploadImageToWordPress(featBuf,  `${fileSlug}-featured.png`, imagePrompts.featured_img_alt),
      ]);

      const uploadLabels = ["kp1", "kp2", "split", "featured"];
      const uploadErrors = uploadResults
        .map((r, i) => r.status === "rejected"
          ? `${uploadLabels[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
          : null)
        .filter(Boolean);

      if (uploadErrors.length > 0) {
        throw new Error(`Image upload(s) failed: ${uploadErrors.join("; ")}`);
      }

      const [kp1, kp2, split, feat] = uploadResults.map(
        (r) => (r as PromiseFulfilledResult<{ id: number; url: string }>).value
      );

      const imageIds = {
        keypointOneImg: kp1.id,
        keypointTwoImg: kp2.id,
        postSplitImg:   split.id,
        featuredImg:    feat.id,
      };

      // ── Step 4: Attach article images to post ───────────────
      await send({ type: "progress", message: "Attaching images to post…" });
      await updateWordPressPostImages(postId, imageIds);
      console.log(`[generate-images] Images attached to post ${postId}`);

      // ── Step 5: Embed flowchart in article content ──────────
      // Strategy:
      //   1. Search all candidate fields for the [FLOWCHART_IMG] placeholder
      //      GPT was asked to write — replace it if found.
      //   2. If the placeholder isn't present (GPT often omits it inside JSON),
      //      fall back to appending the diagram to more_content_2, which is
      //      typically the most data-rich body section.
      if (flowchartImgTag) {
        await send({ type: "progress", message: "Embedding flowchart in article…" });
        try {
          const acf = await fetchPostAcf(postId);
          let embedded = false;

          // Pass 1 — look for the explicit placeholder
          for (const { acf: fieldName } of FLOWCHART_FIELDS) {
            const fieldValue = acf[fieldName] ?? "";
            if (fieldValue.includes("[FLOWCHART_IMG]")) {
              const updated = fieldValue.replace(/\[FLOWCHART_IMG\]/g, flowchartImgTag);
              await patchWordPressContentField(postId, fieldName, updated);
              console.log(`[generate-images] Flowchart embedded via placeholder in ${fieldName}`);
              embedded = true;
              break;
            }
          }

          // Pass 2 — fallback: append to more_content_2
          if (!embedded) {
            const fallbackField = "more_content_2";
            const existing = acf[fallbackField] ?? "";
            const updated  = existing
              ? `${existing}\n${flowchartImgTag}`
              : flowchartImgTag;
            await patchWordPressContentField(postId, fallbackField, updated);
            console.log(`[generate-images] Flowchart appended to ${fallbackField} (placeholder not found)`);
          }
        } catch (embedErr) {
          console.warn(`[generate-images] Flowchart embed failed (non-fatal): ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`);
        }
      } else {
        // Render failed or no Mermaid provided — strip any leftover [FLOWCHART_IMG]
        // placeholder so the literal text never appears in the published article.
        try {
          const acf = await fetchPostAcf(postId);
          for (const { acf: fieldName } of FLOWCHART_FIELDS) {
            const fieldValue = acf[fieldName] ?? "";
            if (fieldValue.includes("[FLOWCHART_IMG]")) {
              const cleaned = fieldValue.replace(/\s*\[FLOWCHART_IMG\]\s*/g, "\n").trim();
              await patchWordPressContentField(postId, fieldName, cleaned);
              console.log(`[generate-images] Stripped leftover [FLOWCHART_IMG] placeholder from ${fieldName} (no flowchart image)`);
            }
          }
        } catch (stripErr) {
          console.warn(`[generate-images] Placeholder strip failed (non-fatal): ${stripErr instanceof Error ? stripErr.message : String(stripErr)}`);
        }
      }

      await send({ type: "done", imageIds, flowchartEmbedded: !!flowchartImgTag });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[generate-images] Failed: ${msg}`);
      await send({ type: "error", message: msg });
    }
  })().finally(() => writer.close().catch(() => {}));

  return new Response(stream.readable, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
