/**
 * lib/wordpress.ts
 * ─────────────────────────────────────────────────────────────
 * All WordPress REST API interactions live here.
 * Runs on Vercel servers (trusted US/EU IPs) — never blocked
 * by SiteGround's Anti-Bot system.
 */

import axios from "axios";
import FormData from "form-data";

const WP_URL = process.env.WP_URL!;
const WP_USERNAME = process.env.WP_USERNAME!;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;

// Base64-encoded credentials for HTTP Basic Auth
const WP_AUTH = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

// Standard headers for all JSON requests
const BASE_HEADERS = {
  Authorization: `Basic ${WP_AUTH}`,
  "Content-Type": "application/json",
  "User-Agent": "AstonBlogTool/1.0 (Vercel; +https://aston.ae)",
};

/**
 * Upload an image buffer to the WordPress media library.
 * Returns the WordPress media ID (integer) for use in ACF image fields.
 */
export async function uploadImageToWordPress(
  imageBuffer: Buffer,
  filename: string,
  altText: string
): Promise<number> {
  const form = new FormData();
  form.append("file", imageBuffer, {
    filename,
    contentType: "image/png",
  });

  let response;
  try {
    response = await axios.post(`${WP_URL}/wp-json/wp/v2/media`, form, {
      headers: {
        Authorization: `Basic ${WP_AUTH}`,
        "User-Agent": "AstonBlogTool/1.0 (Vercel; +https://aston.ae)",
        ...form.getHeaders(),
      },
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const detail = JSON.stringify(err.response?.data ?? err.message);
      throw new Error(`WP media upload failed (${err.response?.status}): ${detail}`);
    }
    throw err;
  }

  const mediaId = response.data?.id;
  if (!mediaId) {
    throw new Error(`WP media upload: no ID returned. Response: ${JSON.stringify(response.data)}`);
  }

  // Set alt text for SEO and accessibility
  await axios.post(
    `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
    { alt_text: altText },
    { headers: BASE_HEADERS }
  );

  return mediaId;
}

/**
 * Create a WordPress post with all ACF fields pre-filled.
 * Posts as "draft" so you can review before publishing.
 */
export async function createWordPressPost(
  content: BlogContent,
  imageIds: { keypointOneImg: number; keypointTwoImg: number; postSplitImg: number }
) {
  let response;
  try {
    response = await axios.post(
    `${WP_URL}/wp-json/wp/v2/posts`,
    {
      // ── Standard WordPress fields ──────────────────────
      title: content.post_title,
      content: content.main_content,
      status: "draft",
      excerpt: content.seo_excerpt,

      // ── ACF custom fields ──────────────────────────────
      // Field formats matched exactly to how existing posts store them:
      // - Key_takeaways: HTML <ul><li> list (not plain bullet text)
      // - read_mins: integer only (not "7 min read" string)
      // - keypoint_one_img / Keypoint_Two_Img: media ID integer
      // - post_split_img / Final_Points: stored as empty string when unused
      acf: {
        Key_takeaways:    content.key_takeaways,   // HTML formatted by GPT
        Keypoint_One:     content.keypoint_one,
        keypoint_one_img: imageIds.keypointOneImg,  // integer media ID
        more_content_1:   content.more_content_1,
        more_content_2:   content.more_content_2,
        quote_1:          content.quote_1,
        more_content_3:   content.more_content_3,
        more_content_4:   content.more_content_4,
        quote_2:          content.quote_2,
        more_content_5:   content.more_content_5,
        Keypoint_Two:     content.keypoint_two,
        Keypoint_Two_Img: imageIds.keypointTwoImg, // integer media ID
        more_content_6:   content.more_content_6,
        read_mins:        parseInt(content.read_mins, 10) || 7, // integer only
        post_split_img:   imageIds.postSplitImg,   // integer media ID
        Final_Points:     content.final_points,
      },
    },
    { headers: BASE_HEADERS }
  );
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const detail = JSON.stringify(err.response?.data ?? err.message);
      throw new Error(`WP post creation failed (${err.response?.status}): ${detail}`);
    }
    throw err;
  }

  return response.data;
}

// ── Shared type used across the app ───────────────────────────
export interface BlogContent {
  post_title: string;
  read_mins: string;
  seo_excerpt: string;
  key_takeaways: string;
  main_content: string;
  keypoint_one: string;
  keypoint_one_img_prompt: string;
  more_content_1: string;
  more_content_2: string;
  quote_1: string;
  more_content_3: string;
  more_content_4: string;
  quote_2: string;
  more_content_5: string;
  keypoint_two: string;
  keypoint_two_img_prompt: string;
  more_content_6: string;
  post_split_img_prompt: string;
  final_points: string;
}
