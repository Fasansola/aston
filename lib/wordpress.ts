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
 * Returns the media ID and public URL — ID for ACF fields, URL for inline img tags.
 */
export async function uploadImageToWordPress(
  imageBuffer: Buffer,
  filename: string,
  altText: string
): Promise<{ id: number; url: string }> {
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
  const mediaUrl = response.data?.source_url ?? "";
  if (!mediaId) {
    throw new Error(`WP media upload: no ID returned. Response: ${JSON.stringify(response.data)}`);
  }

  // Set alt text for SEO and accessibility
  await axios.post(
    `${WP_URL}/wp-json/wp/v2/media/${mediaId}`,
    { alt_text: altText },
    { headers: BASE_HEADERS }
  );

  return { id: mediaId, url: mediaUrl };
}

/**
 * Create a WordPress post with all ACF fields pre-filled.
 * Posts as "draft" so you can review before publishing.
 * assembled contains the content sections with IMGSLOT placeholders replaced.
 */
export async function createWordPressPost(
  title: string,
  content: BlogContent,
  assembled: {
    main_content: string;
    more_content_1: string;
    more_content_3: string;
    more_content_4: string;
  },
  imageIds: { keypointOneImg: number; keypointTwoImg: number; postSplitImg: number; featuredImg: number }
) {
  let response;
  try {
    response = await axios.post(
      `${WP_URL}/wp-json/wp/v2/posts`,
      {
        // ── Standard WordPress fields ──────────────────────
        title,
        content: assembled.main_content,
        status: "draft",
        featured_media: imageIds.featuredImg,

        // ── Yoast SEO ──────────────────────────────────────
        meta: {
          yoast_wpseo_focuskw: content.focus_keyword,
        },

        // ── ACF custom fields ──────────────────────────────
        acf: {
          Key_takeaways:    content.key_takeaways,
          Keypoint_One:     content.keypoint_one,
          keypoint_one_img: imageIds.keypointOneImg,
          more_content_1:   assembled.more_content_1,
          more_content_2:   content.more_content_2,
          quote_1:          content.quote_1,
          more_content_3:   assembled.more_content_3,
          Keypoint_Two:     content.keypoint_two,
          Keypoint_Two_Img: imageIds.keypointTwoImg,
          more_content_4:   assembled.more_content_4,
          quote_2:          content.quote_2,
          read_mins:        parseInt(content.read_mins, 10) || 7,
          post_split_img:   imageIds.postSplitImg,
          Final_Points:     content.final_points,
          more_content_5:   "",
          more_content_6:   "",
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
  focus_keyword: string;
  secondary_keywords: string[];
  main_content: string;
  keypoint_one: string;
  more_content_1: string;
  more_content_2: string;
  quote_1: string;
  more_content_3: string;
  keypoint_two: string;
  more_content_4: string;
  quote_2: string;
  key_takeaways: string;
  final_points: string;
  read_mins: string;
  keypoint_one_img_prompt: string;
  keypoint_one_img_alt: string;
  keypoint_two_img_prompt: string;
  keypoint_two_img_alt: string;
  post_split_img_prompt: string;
  post_split_img_alt: string;
  featured_img_prompt: string;
  featured_img_alt: string;
}
