/**
 * app/api/generate/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate
 *
 * This is the core serverless function. It runs on Vercel's
 * US/EU servers — trusted IPs that SiteGround never blocks.
 *
 * Flow:
 *  1. Validate request + API secret
 *  2. Generate blog content with GPT-4o
 *  3. Generate 3 images with DALL·E 3 (in parallel)
 *  4. Upload images to WordPress media library
 *  5. Create WordPress post with all ACF fields
 *  6. Return the draft post URL
 */

import { NextRequest, NextResponse } from "next/server";
import { generateBlogContent, generateImage } from "@/lib/openai";
import { uploadImageToWordPress, createWordPressPost } from "@/lib/wordpress";

// Vercel has a default 10s timeout on hobby plans.
// Set to 60s — requires Pro plan or self-hosted.
// On hobby plan, image generation may timeout; upgrade if needed.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // ── 1. Validate request ──────────────────────────────
    const body = await req.json();
    const { topic, secret } = body;

    if (!topic || typeof topic !== "string" || topic.trim().length < 5) {
      return NextResponse.json(
        { error: "Please provide a valid topic (at least 5 characters)." },
        { status: 400 }
      );
    }

    // Protect the endpoint with a secret key
    if (secret !== process.env.API_SECRET) {
      return NextResponse.json(
        { error: "Unauthorized." },
        { status: 401 }
      );
    }

    // ── 2. Generate blog content ─────────────────────────
    console.log(`[generate] Starting for topic: "${topic}"`);
    const content = await generateBlogContent(topic.trim());
    console.log(`[generate] Content ready: "${content.post_title}"`);

    // ── 3. Generate all 3 images in parallel ─────────────
    console.log("[generate] Generating images...");
    const [kp1Buffer, kp2Buffer, splitBuffer] = await Promise.all([
      generateImage(content.keypoint_one_img_prompt),
      generateImage(content.keypoint_two_img_prompt),
      generateImage(content.post_split_img_prompt),
    ]);
    console.log("[generate] Images generated.");

    // Build a URL-safe slug for filenames
    const slug = content.post_title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);

    // ── 4. Upload images to WordPress ────────────────────
    console.log("[generate] Uploading images to WordPress...");
    const [kp1MediaId, kp2MediaId, splitMediaId] = await Promise.all([
      uploadImageToWordPress(kp1Buffer, `${slug}-kp1.png`, content.keypoint_one),
      uploadImageToWordPress(kp2Buffer, `${slug}-kp2.png`, content.keypoint_two),
      uploadImageToWordPress(splitBuffer, `${slug}-split.png`, content.post_title),
    ]);
    console.log(`[generate] Images uploaded: ${kp1MediaId}, ${kp2MediaId}, ${splitMediaId}`);

    // ── 5. Create the WordPress post ─────────────────────
    console.log("[generate] Creating WordPress post...");
    const post = await createWordPressPost(content, {
      keypointOneImg: kp1MediaId,
      keypointTwoImg: kp2MediaId,
      postSplitImg: splitMediaId,
    });
    console.log(`[generate] Post created! ID: ${post.id}`);

    // ── 6. Return success ─────────────────────────────────
    return NextResponse.json({
      success: true,
      postId: post.id,
      title: content.post_title,
      readMins: content.read_mins,
      editUrl: `${process.env.WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`,
      previewUrl: post.link,
    });

  } catch (error: unknown) {
    console.error("[generate] Error:", error);

    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";

    // Log full error on server for Vercel dashboard debugging
    console.error("[generate] Full error:", JSON.stringify(error, Object.getOwnPropertyNames(error)));

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
