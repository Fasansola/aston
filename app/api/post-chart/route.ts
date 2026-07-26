/**
 * app/api/post-chart/route.ts
 * ─────────────────────────────────────────────────────────────
 * Post-hoc chart insertion for an ALREADY-published post.
 *
 * GET  /api/post-chart?id=<postId>   (or ?url=<full url|slug>)
 *   → { post: { id, title, focusKeyword, blogUrl }, hasChart }
 *
 * POST /api/post-chart   { postId }
 *   → generates one aston-chart-block from the finished article, inserts it
 *     into a body section, PATCHes WordPress, and returns { ok, field, chartHtml }.
 *
 * Unlike audio/video/podcast (heavy, async, durable-workflow jobs), a chart is
 * just body HTML: one LLM call + one field PATCH. So this runs synchronously —
 * no workflow, no SSE. Charts are inserted straight into the live post, matching
 * the frictionless "Add media" flow.
 */

import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { generateChartBlock, type ChartSourceContent } from "@/lib/chart";
import { patchWordPressContentField } from "@/lib/wordpress";

const WP_URL = process.env.WP_URL!;
const AUTH = { auth: { username: process.env.WP_USERNAME!, password: process.env.WP_APP_PASSWORD! } };

// Insertable body fields (ACF). main_content is excluded — it is the WP post
// content (not an ACF field) and usually holds the intro rather than data.
const BODY_FIELDS = ["more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"] as const;
const CHART_MARKER = "aston-chartjs";

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Turn a full WordPress URL (or bare slug) into the post's slug — the last
// non-empty path segment. Handles Polylang language prefixes and trailing
// slashes: "https://aston.ae/de/mein-artikel/" → "mein-artikel".
function slugFromUrl(input: string): string {
  const trimmed = input.trim();
  try {
    const u = new URL(trimmed);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] ?? "";
  } catch {
    return trimmed.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  }
}

async function fetchPostRaw(opts: { id?: string | number; url?: string }): Promise<Record<string, unknown>> {
  if (opts.id !== undefined && opts.id !== "") {
    const { data } = await axios.get(`${WP_URL}/wp-json/wp/v2/posts/${opts.id}?context=edit`, AUTH);
    return data;
  }
  const slug = slugFromUrl(opts.url ?? "");
  if (!slug) throw new Error("Could not read a post slug from that URL");
  const { data } = await axios.get(`${WP_URL}/wp-json/wp/v2/posts`, {
    ...AUTH,
    params: { slug, status: "any", context: "edit", per_page: 1 },
  });
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No post found for "${slug}". Check the URL, or use the post ID.`);
  }
  return data[0];
}

async function loadPost(opts: { id?: string | number; url?: string }) {
  const post = await fetchPostRaw(opts);
  const acf = (post.acf ?? {}) as Record<string, unknown>;
  const meta = (post.meta ?? {}) as Record<string, unknown>;

  const content: ChartSourceContent = {
    main_content:   str((post.content as { rendered?: string })?.rendered),
    more_content_1: str(acf.more_content_1),
    more_content_2: str(acf.more_content_2),
    more_content_3: str(acf.more_content_3),
    more_content_4: str(acf.more_content_4),
    more_content_5: str(acf.more_content_5),
    more_content_6: str(acf.more_content_6),
    final_points:   str(acf.Final_Points),
  };

  const hasChart =
    content.main_content.includes(CHART_MARKER) ||
    BODY_FIELDS.some((f) => str(acf[f]).includes(CHART_MARKER));

  return {
    id: post.id as number,
    title: str((post.title as { raw?: string })?.raw) || str((post.title as { rendered?: string })?.rendered),
    focusKeyword: str(meta._yoast_wpseo_focuskw) || str(acf.focus_keyword),
    blogUrl: str(post.link),
    content,
    acf,
    hasChart,
  };
}

// Choose the best body field to receive the chart: the longest prose section
// that has no chart yet and contains a paragraph break. Falls back to
// more_content_2 (the same field embedFlowchartHtml appends to).
function pickTargetField(acf: Record<string, unknown>): { field: string; value: string } {
  const candidates = BODY_FIELDS
    .map((f) => ({ field: f, value: str(acf[f]) }))
    .filter((c) => c.value.trim() && !c.value.includes(CHART_MARKER));

  const withParagraph = candidates.filter((c) => /<\/p>/i.test(c.value));
  const pool = withParagraph.length ? withParagraph : candidates;
  pool.sort((a, b) => b.value.replace(/<[^>]+>/g, " ").length - a.value.replace(/<[^>]+>/g, " ").length);

  if (pool.length) return pool[0];
  return { field: "more_content_2", value: str(acf.more_content_2) };
}

// Insert the block right after the first closing paragraph; otherwise append.
function insertChart(fieldValue: string, block: string): string {
  const m = fieldValue.match(/<\/p>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return `${fieldValue.slice(0, at)}\n${block}\n${fieldValue.slice(at)}`;
  }
  return `${fieldValue.trim()}\n${block}`.trim();
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  const url = req.nextUrl.searchParams.get("url");
  if (!id && !url) return NextResponse.json({ error: "Provide a post id or url" }, { status: 400 });

  try {
    const p = await loadPost(id ? { id } : { url: url! });
    return NextResponse.json({
      post: { id: p.id, title: p.title, focusKeyword: p.focusKeyword, blogUrl: p.blogUrl },
      hasChart: p.hasChart,
    });
  } catch (err) {
    console.error("[post-chart:GET]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load post" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { postId?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid body" }, { status: 400 }); }

  const { postId } = body;
  if (!postId || typeof postId !== "number") return NextResponse.json({ error: "postId is required" }, { status: 400 });

  try {
    const p = await loadPost({ id: postId });
    const block = await generateChartBlock(p.content, { title: p.title, focusKeyword: p.focusKeyword });

    const target = pickTargetField(p.acf);
    const updated = insertChart(target.value, block);
    await patchWordPressContentField(p.id, target.field, updated);

    return NextResponse.json({ ok: true, field: target.field, blogUrl: p.blogUrl, chartHtml: block });
  } catch (err) {
    console.error("[post-chart:POST]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to add chart" }, { status: 500 });
  }
}
