/**
 * app/api/post-media/route.ts
 * ─────────────────────────────────────────────────────────────
 * Post-hoc media generation for an ALREADY-published post.
 *
 * GET  /api/post-media?id=<postId>
 *   → { post: { id, title, focusKeyword, language, blogUrl },
 *       existing: { audio, video, podcast } }   // what the post already has
 *
 * POST /api/post-media   { postId, outputs:{audio,video,podcast}, podcastLength? }
 *   → starts the durable generateMediaWorkflow for the selected outputs and
 *     returns its run id (X-Workflow-Run-Id header). The client follows
 *     GET /api/post-media/<runId> for live progress.
 *
 * Article content is pulled back out of WordPress so audio/video narration can
 * be regenerated without the original in-memory generation state.
 */

import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { start } from "workflow/api";
import { generateMediaWorkflow, type MediaContentFields } from "@/lib/workflows/generateMedia";

const WP_URL = process.env.WP_URL!;
const AUTH = { auth: { username: process.env.WP_USERNAME!, password: process.env.WP_APP_PASSWORD! } };
const PODCAST_CPT = process.env.PODCAST_CPT_REST_BASE || "podcast";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function loadPost(id: string | number) {
  const { data: post } = await axios.get(`${WP_URL}/wp-json/wp/v2/posts/${id}?context=edit`, AUTH);
  const acf = (post.acf ?? {}) as Record<string, unknown>;
  const meta = (post.meta ?? {}) as Record<string, unknown>;

  const content: MediaContentFields = {
    main_content:   str((post.content as { rendered?: string })?.rendered),
    more_content_1: str(acf.more_content_1),
    more_content_2: str(acf.more_content_2),
    more_content_3: str(acf.more_content_3),
    more_content_4: str(acf.more_content_4),
    more_content_5: str(acf.more_content_5),
    more_content_6: str(acf.more_content_6),
    final_points:   str(acf.Final_Points),
  };

  return {
    id: post.id as number,
    title: str((post.title as { rendered?: string; raw?: string })?.raw) || str((post.title as { rendered?: string })?.rendered),
    focusKeyword: str(meta._yoast_wpseo_focuskw) || str(acf.focus_keyword),
    language: str(post.lang) || "",
    blogUrl: str(post.link),
    summary: str((post.excerpt as { rendered?: string })?.rendered).replace(/<[^>]+>/g, " ").trim(),
    content,
    existing: {
      audio:   !!str(acf.audio_url).trim(),
      video:   !!str(acf.video_url).trim(),
      // best-effort: content already carries a Spotify embed once the podcast synced
      podcast: content.main_content.includes("open.spotify.com/embed"),
    },
  };
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const p = await loadPost(id);
    // Refine podcast detection with a CPT lookup (source_post_id === this post).
    let podcast = p.existing.podcast;
    if (!podcast) {
      try {
        const { data } = await axios.get(`${WP_URL}/wp-json/wp/v2/${PODCAST_CPT}`, {
          ...AUTH,
          params: { per_page: 1, _fields: "id", meta_key: "source_post_id", meta_value: String(p.id) },
        });
        if (Array.isArray(data) && data.length > 0) podcast = true;
      } catch { /* CPT may not support meta query — leave as-is */ }
    }
    return NextResponse.json({
      post: { id: p.id, title: p.title, focusKeyword: p.focusKeyword, language: p.language, blogUrl: p.blogUrl },
      existing: { ...p.existing, podcast },
    });
  } catch (err) {
    console.error("[post-media:GET]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load post" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { postId?: number; outputs?: { audio?: boolean; video?: boolean; podcast?: boolean }; podcastLength?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }

  const { postId, outputs, podcastLength = 30 } = body;
  if (!postId || typeof postId !== "number") return NextResponse.json({ error: "postId is required" }, { status: 400 });
  const wanted = { audio: outputs?.audio === true, video: outputs?.video === true, podcast: outputs?.podcast === true };
  if (!wanted.audio && !wanted.video && !wanted.podcast) {
    return NextResponse.json({ error: "Select at least one media output" }, { status: 400 });
  }
  if (![3, 15, 30, 45, 60].includes(podcastLength)) {
    return NextResponse.json({ error: "podcastLength must be one of: 3, 15, 30, 45, 60" }, { status: 400 });
  }

  try {
    const p = await loadPost(postId);
    const run = await start(generateMediaWorkflow, [{
      postId: p.id,
      title: p.title,
      focusKeyword: p.focusKeyword,
      secondaryKeywords: [],
      summary: p.summary,
      blogUrl: p.blogUrl || null,
      language: p.language || null,
      content: p.content,
      outputs: wanted,
      podcastLength,
    }]);

    return new NextResponse(JSON.stringify({ runId: run.runId }), {
      status: 202,
      headers: { "Content-Type": "application/json", "X-Workflow-Run-Id": run.runId },
    });
  } catch (err) {
    console.error("[post-media:POST]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to start media generation" }, { status: 500 });
  }
}
