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

const WP_URL = process.env.WP_URL!;
const AUTH = { auth: { username: process.env.WP_USERNAME!, password: process.env.WP_APP_PASSWORD! } };

// ACF body sections a fresh chart may be inserted into. main_content is scanned
// for existing chart boxes too (see EDITABLE_FIELDS) but not chosen for fresh
// inserts — it usually holds the intro rather than data.
const INSERT_FIELDS = ["more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"] as const;

// A rendered, working chart — the canvas the live theme draws into.
const WORKING_CHART = "aston-chartjs";
// Any chart container, working OR a leftover empty box from a failed generation.
const CHART_BOX = "aston-chart-block";
// Matches a whole aston-chart-block div (non-greedy to the first </div>, which
// is safe because these blocks never nest divs — same assumption as the
// generation-time sanitizer in lib/chartSanitizer.ts).
const chartBoxRegex = () => /<div\b[^>]*class="[^"]*aston-chart-block[^"]*"[^>]*>[\s\S]*?<\/div>/gi;

interface EditableField { name: string; value: string; isAcf: boolean; }

const tidy = (s: string) => s.replace(/\n{3,}/g, "\n\n").trim();

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
  const contentRaw = str((post.content as { raw?: string })?.raw) || str((post.content as { rendered?: string })?.rendered);

  const content: ChartSourceContent = {
    main_content:   contentRaw,
    more_content_1: str(acf.more_content_1),
    more_content_2: str(acf.more_content_2),
    more_content_3: str(acf.more_content_3),
    more_content_4: str(acf.more_content_4),
    more_content_5: str(acf.more_content_5),
    more_content_6: str(acf.more_content_6),
    final_points:   str(acf.Final_Points),
  };

  // Editable fields in reading order — main_content first, then the body
  // sections. Used to find, replace, or remove chart boxes.
  const fields: EditableField[] = [
    { name: "main_content", value: contentRaw, isAcf: false },
    ...INSERT_FIELDS.map((f) => ({ name: f, value: str(acf[f]), isAcf: true })),
  ];

  // "Has a chart" = has a working canvas. A leftover empty box (no canvas) does
  // NOT count, so the UI still offers to add one — clicking will refill the box.
  const hasChart = fields.some((f) => f.value.includes(WORKING_CHART));

  return {
    id: post.id as number,
    title: str((post.title as { raw?: string })?.raw) || str((post.title as { rendered?: string })?.rendered),
    focusKeyword: str(meta._yoast_wpseo_focuskw) || str(acf.focus_keyword),
    blogUrl: str(post.link),
    content,
    fields,
    hasChart,
  };
}

// Insert the block right after the first closing paragraph; otherwise append.
function insertAfterFirstParagraph(fieldValue: string, block: string): string {
  const m = fieldValue.match(/<\/p>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return tidy(`${fieldValue.slice(0, at)}\n${block}\n${fieldValue.slice(at)}`);
  }
  return tidy(`${fieldValue.trim()}\n${block}`);
}

/**
 * Decide how to write the chart, and which fields change.
 *  - If the post already has one or more aston-chart-block containers (working
 *    OR leftover empty boxes), replace the FIRST one (in reading order) with the
 *    new chart and strip every other box. This keeps the chart in its original
 *    position and removes duplicates — self-healing posts where a failed chart
 *    left an empty box and a previous run appended a second one.
 *  - Otherwise insert a fresh chart into the first body section that has a
 *    paragraph (earliest position, not the longest section).
 */
function planChartWrite(fields: EditableField[], block: string): { changes: EditableField[]; mode: "replaced" | "inserted" } {
  const hasBox = fields.some((f) => new RegExp(CHART_BOX, "i").test(f.value));

  if (hasBox) {
    const changes: EditableField[] = [];
    let replacedFirst = false;
    for (const f of fields) {
      if (!new RegExp(CHART_BOX, "i").test(f.value)) continue;
      const firstFieldWithBox = !replacedFirst;
      let matchIndex = 0;
      const newValue = f.value.replace(chartBoxRegex(), () => {
        const keep = firstFieldWithBox && matchIndex === 0 ? block : "";
        matchIndex++;
        return keep;
      });
      replacedFirst = true;
      changes.push({ ...f, value: tidy(newValue) });
    }
    return { changes, mode: "replaced" };
  }

  const insertable = fields.filter((f) => f.name !== "main_content");
  const target =
    insertable.find((f) => /<\/p>/i.test(f.value) && f.value.trim()) ??
    insertable.find((f) => f.value.trim()) ??
    insertable.find((f) => f.name === "more_content_2")!;
  return { changes: [{ ...target, value: insertAfterFirstParagraph(target.value, block) }], mode: "inserted" };
}

// PATCH the changed fields in one request: main_content → `content`, the rest
// → their ACF keys.
async function writeFields(postId: number, changes: EditableField[]): Promise<void> {
  const acf: Record<string, string> = {};
  const body: { content?: string; acf?: Record<string, string> } = {};
  for (const c of changes) {
    if (c.isAcf) acf[c.name] = c.value;
    else body.content = c.value;
  }
  if (Object.keys(acf).length) body.acf = acf;
  await axios.post(`${WP_URL}/wp-json/wp/v2/posts/${postId}`, body, AUTH);
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

    const { changes, mode } = planChartWrite(p.fields, block);
    await writeFields(p.id, changes);

    return NextResponse.json({
      ok: true,
      mode,
      fields: changes.map((c) => c.name),
      blogUrl: p.blogUrl,
      chartHtml: block,
    });
  } catch (err) {
    console.error("[post-chart:POST]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to add chart" }, { status: 500 });
  }
}
