/**
 * app/api/generate/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate
 *
 * Runs on Vercel — trusted IPs that SiteGround never blocks.
 *
 * Pipeline:
 *  1. Validate request + API secret
 *  2. Select relevant links for the topic (link manager)
 *  3. Generate blog content + SEO metadata with GPT-4o
 *  4. Generate 4 content-aware image prompts with GPT-4o
 *  5. Generate 4 images with DALL·E 3 (in parallel)
 *  6. Upload images to WordPress media library (in parallel)
 *  7. Create WordPress draft post with all ACF + Yoast fields
 *  8. Return the draft post URL
 */

import { NextRequest, NextResponse } from "next/server";
import { generateBlogContent, generateImagePrompts, generateImage } from "@/lib/openai";
import { uploadImageToWordPress, createWordPressPost } from "@/lib/wordpress";
import { selectLinks } from "@/lib/links";

// Vercel default timeout is 300s on all plans.
// We set 180s as a safe ceiling — the full pipeline takes ~90-120s.
export const maxDuration = 180;


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

    if (secret !== process.env.API_SECRET) {
      return NextResponse.json(
        { error: "Unauthorized." },
        { status: 401 }
      );
    }

    const title = topic.trim();

    // ── 2. Select relevant links ─────────────────────────
    console.log(`[generate] Starting for title: "${title}"`);
    const selectedLinks = selectLinks(title);
    console.log(
      `[generate] Selected ${selectedLinks.internal.length} internal + ${selectedLinks.external.length} external links`
    );

    // ── 3. Generate blog content + SEO ───────────────────
    const content = await generateBlogContent(title, selectedLinks);
    console.log(
      `[generate] Content ready. Focus keyword: "${content.focus_keyword}", slug: "${content.slug}"`
    );

    // ── 4. Generate content-aware image prompts ──────────
    console.log("[generate] Generating image prompts from content...");
    const imagePrompts = await generateImagePrompts(title, content);
    console.log("[generate] Image prompts ready.");

    // ── 5. Generate all 4 images in parallel ─────────────
    console.log("[generate] Generating images with DALL·E 3...");
    const [kp1Buffer, kp2Buffer, splitBuffer, featuredBuffer] = await Promise.all([
      generateImage(imagePrompts.keypoint_one_img_prompt),
      generateImage(imagePrompts.keypoint_two_img_prompt),
      generateImage(imagePrompts.post_split_img_prompt),
      generateImage(imagePrompts.featured_img_prompt),
    ]);
    console.log("[generate] Images generated.");

    // Build a URL-safe slug for media filenames
    const fileSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);

    // ── 6. Upload images to WordPress ────────────────────
    console.log("[generate] Uploading images to WordPress...");
    const [kp1Media, kp2Media, splitMedia, featuredMedia] = await Promise.all([
      uploadImageToWordPress(kp1Buffer, `${fileSlug}-kp1.png`, imagePrompts.keypoint_one_img_alt),
      uploadImageToWordPress(kp2Buffer, `${fileSlug}-kp2.png`, imagePrompts.keypoint_two_img_alt),
      uploadImageToWordPress(splitBuffer, `${fileSlug}-split.png`, imagePrompts.post_split_img_alt),
      uploadImageToWordPress(featuredBuffer, `${fileSlug}-featured.png`, imagePrompts.featured_img_alt),
    ]);
    console.log(
      `[generate] Images uploaded: ${kp1Media.id}, ${kp2Media.id}, ${splitMedia.id}, ${featuredMedia.id}`
    );

    // ── 7. Strip IMGSLOT placeholders (images handled by ACF) ──
    const assembled = {
      main_content:   content.main_content.replace("IMGSLOT_MAIN", ""),
      more_content_1: content.more_content_1.replace("IMGSLOT_ONE", ""),
      more_content_3: content.more_content_3.replace("IMGSLOT_TWO", ""),
      more_content_4: content.more_content_4.replace("IMGSLOT_SPLIT", ""),
    };

    // ── 8. Create the WordPress post ─────────────────────
    console.log("[generate] Creating WordPress post...");
    const post = await createWordPressPost(title, content, imagePrompts, assembled, {
      keypointOneImg: kp1Media.id,
      keypointTwoImg: kp2Media.id,
      postSplitImg:   splitMedia.id,
      featuredImg:    featuredMedia.id,
    });
    console.log(`[generate] Post created! ID: ${post.id}, slug: "${content.slug}"`);

    // ── 9. Return success ─────────────────────────────────
    return NextResponse.json({
      success: true,
      postId: post.id,
      title,
      slug: content.slug,
      focusKeyword: content.focus_keyword,
      seoTitle: content.seo_title,
      readMins: content.read_mins,
      linksUsed: {
        internal: content.internal_links_used,
        external: content.external_links_used,
      },
      editUrl: `${process.env.WP_URL}/wp-admin/post.php?post=${post.id}&action=edit`,
      previewUrl: post.link,
    });

  } catch (error: unknown) {
    console.error("[generate] Error:", error);

    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";

    console.error(
      "[generate] Full error:",
      JSON.stringify(error, Object.getOwnPropertyNames(error))
    );

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
