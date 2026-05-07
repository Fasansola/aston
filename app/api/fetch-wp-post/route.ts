/**
 * app/api/fetch-wp-post/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/fetch-wp-post?search=<query>   — search posts by title
 * GET /api/fetch-wp-post?id=<postId>      — fetch a single post's content
 * GET /api/fetch-wp-post?url=<postUrl>    — fetch a post by its URL/slug
 *
 * Returns post content (all ACF fields + main content) ready to be
 * pasted into the "Improve Existing" generation mode as source text.
 */

import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

const WP_URL      = process.env.WP_URL!;
const WP_USERNAME = process.env.WP_USERNAME!;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;

const AUTH = { auth: { username: WP_USERNAME, password: WP_APP_PASSWORD } };

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

// Concatenate all ACF + main content fields into a single plain-text blob
function assemblePostContent(post: Record<string, unknown>): string {
  const acf = (post.acf ?? {}) as Record<string, string>;
  const mainContent = (post.content as { rendered?: string })?.rendered ?? "";

  const ACF_FIELDS = [
    "Key_takeaways", "Keypoint_One", "more_content_1", "more_content_2",
    "quote_1", "more_content_3", "Keypoint_Two", "more_content_4",
    "quote_2", "Final_Points", "more_content_5", "more_content_6",
  ];

  const parts = [mainContent, ...ACF_FIELDS.map((f) => acf[f] ?? "")].filter(Boolean);

  // Strip HTML tags to give the AI clean text
  return parts.join("\n\n").replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search");
  const id     = searchParams.get("id");
  const url    = searchParams.get("url");
  // Note: using URL constructor directly (not Next.js req.nextUrl) so no async needed

  try {
    // ── Search by title ──────────────────────────────────────
    if (search) {
      const { data } = await axios.get(
        `${WP_URL}/wp-json/wp/v2/posts`,
        {
          ...AUTH,
          params: {
            search,
            per_page: 10,
            status: "any",
            _fields: "id,title,slug,status,date,link",
          },
        }
      );
      const posts = Array.isArray(data) ? data : [];
      return NextResponse.json({
        posts: posts.map((p: Record<string, unknown>) => ({
          id:     p.id,
          title:  (p.title as { rendered?: string; raw?: string })?.rendered
                  ?? (p.title as { rendered?: string; raw?: string })?.raw
                  ?? String(p.title ?? ""),
          slug:   p.slug,
          status: p.status,
          date:   p.date,
          link:   p.link,
        })),
      });
    }

    // ── Fetch single post by ID ──────────────────────────────
    if (id) {
      const { data: post } = await axios.get(
        `${WP_URL}/wp-json/wp/v2/posts/${id}?context=edit`,
        AUTH
      );
      return NextResponse.json({
        id:      post.id,
        title:   post.title?.rendered ?? post.title?.raw ?? "",
        slug:    post.slug,
        status:  post.status,
        link:    post.link,
        content: assemblePostContent(post),
      });
    }

    // ── Fetch by URL / slug ──────────────────────────────────
    if (url) {
      // Extract slug from the URL
      const slug = url.replace(/\/$/, "").split("/").pop() ?? "";
      const { data } = await axios.get(
        `${WP_URL}/wp-json/wp/v2/posts`,
        {
          ...AUTH,
          params: { slug, status: "any", context: "edit" },
        }
      );
      if (!data.length) {
        return NextResponse.json({ error: "Post not found" }, { status: 404 });
      }
      const post = data[0];
      return NextResponse.json({
        id:      post.id,
        title:   post.title?.rendered ?? post.title?.raw ?? "",
        slug:    post.slug,
        status:  post.status,
        link:    post.link,
        content: assemblePostContent(post),
      });
    }

    return NextResponse.json({ error: "Provide search, id, or url parameter" }, { status: 400 });

  } catch (err: unknown) {
    console.error("[fetch-wp-post] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch post" },
      { status: 500 }
    );
  }
}
