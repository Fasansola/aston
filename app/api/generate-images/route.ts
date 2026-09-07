/**
 * app/api/generate-images/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-images
 *
 * Second-phase of the split pipeline:
 *   1. Generates the four article images (kp1, kp2, split, featured)
 *   2. Uploads all four images to WordPress media library
 *   3. Patches the post: attaches image IDs + featured image
 *
 * The flowchart is NOT handled here — it is embedded as styled HTML into the
 * post at publish time (embedFlowchartHtml), independent of image generation.
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
 *   imagePrompts: { ... }
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateImage, type ImageModel } from "@/lib/openai";
import {
  uploadImageToWordPress,
  updateWordPressPostImages,
} from "@/lib/wordpress";
import { s3Available, s3ObjectExists, getS3ObjectBuffer, putS3Object } from "@/lib/sceneImageS3";

// gpt-image-2 reasoning can take minutes per image; allow headroom for the
// four parallel generations plus a retry without hitting the wall.
export const maxDuration = 600;

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

/**
 * Get one article image: from the durable S3 staging copy if an earlier
 * attempt already generated it, otherwise generate it and stage it. Staging
 * is best-effort — without S3 the route behaves exactly as before.
 */
async function obtainImage(
  postId: number, slot: string, prompt: string, model: ImageModel, reused: string[]
): Promise<Buffer> {
  const key = `article-images/${postId}/${slot}.png`;
  const staged = s3Available();
  if (staged) {
    try {
      if (await s3ObjectExists(key)) {
        console.log(`[generate-images] Reusing staged image ${key}`);
        reused.push(slot);
        return await getS3ObjectBuffer(key);
      }
    } catch (err) {
      console.warn(`[generate-images] Staging lookup failed for ${key} (generating instead): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const buf = await generateImageWithRetry(prompt, model, slot);
  if (staged) {
    try {
      await putS3Object(key, buf, "image/png");
    } catch (err) {
      console.warn(`[generate-images] Could not stage ${key} (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return buf;
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
    imagePrompts,
  } = body as {
    postId?: number;
    fileSlug?: string;
    imageModel?: string;
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
    bodyImageModel === "imagen-4" ? "imagen-4" : "gpt-image-2";

  const encoder = new TextEncoder();
  const stream  = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = stream.writable.getWriter();

  const send = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});

  (async () => {
    try {
      // The flowchart is embedded into the post at publish time (styled HTML),
      // independent of this route — so image failures never affect it.

      // ── Obtain 4 article images in parallel (staged copies first) ──
      await send({ type: "progress", message: `Generating 4 images with ${imageModel}${s3Available() ? " (reusing any saved from an earlier attempt)" : ""}…` });
      console.log(`[generate-images] Generating images for post ${postId} with ${imageModel}`);

      const reused: string[] = [];
      const [kp1Buf, kp2Buf, splitBuf, featBuf] = await Promise.all([
        obtainImage(postId, "kp1",      imagePrompts.keypoint_one_img_prompt, imageModel, reused),
        obtainImage(postId, "kp2",      imagePrompts.keypoint_two_img_prompt, imageModel, reused),
        obtainImage(postId, "split",    imagePrompts.post_split_img_prompt,   imageModel, reused),
        obtainImage(postId, "featured", imagePrompts.featured_img_prompt,     imageModel, reused),
      ]);
      if (reused.length) console.log(`[generate-images] ${reused.length} image(s) reused from staging: ${reused.join(", ")}`);

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

      // ── Attach article images to post ───────────────────────
      await send({ type: "progress", message: "Attaching images to post…" });
      await updateWordPressPostImages(postId, imageIds);
      console.log(`[generate-images] Images attached to post ${postId}`);

      await send({ type: "done", imageIds, reused });
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
