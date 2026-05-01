/**
 * app/api/publish-queue/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET    /api/publish-queue  — list all items
 * POST   /api/publish-queue  — add item (with targets + optional scheduledFor)
 * PATCH  /api/publish-queue  — update item (reschedule / pause / retry / cancel)
 * DELETE /api/publish-queue  — remove item by id
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getPublishQueue,
  addPublishQueueItem,
  updatePublishQueueItem,
  deletePublishQueueItem,
} from "@/lib/storage";

export const maxDuration = 15;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const queue = await getPublishQueue();
  const stats = {
    total:      queue.length,
    queued:     queue.filter((i) => i.status === "queued").length,
    processing: queue.filter((i) => i.status === "processing").length,
    published:  queue.filter((i) => i.status === "published").length,
    failed:     queue.filter((i) => i.status === "failed").length,
    paused:     queue.filter((i) => i.status === "paused").length,
  };
  return NextResponse.json({ items: queue.reverse(), stats });
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const {
      title, slug, focusKeyword = "", articleHtml, excerpt = "", tags = [],
      seoTitle = "", metaDescription = "", canonicalUrl, wordCount, wpPostId,
      targets, scheduledFor = null,
    } = body;

    if (!title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });
    if (!articleHtml?.trim()) return NextResponse.json({ error: "articleHtml is required" }, { status: 400 });
    if (!Array.isArray(targets) || targets.length === 0) return NextResponse.json({ error: "at least one target is required" }, { status: 400 });

    const item = await addPublishQueueItem({
      title, slug: slug ?? "", focusKeyword, articleHtml, excerpt, tags,
      seoTitle, metaDescription, canonicalUrl, wordCount, wpPostId,
      targets, scheduledFor,
    });
    console.log(`[publish-queue] Added item ${item.id} — "${title}" → ${targets.map((t: { target: string }) => t.target).join(", ")} (scheduled: ${scheduledFor ?? "ASAP"})`);
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id, ...updates } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    // If retrying a failed item, reset retry count and clear error
    if (updates.status === "queued") {
      updates.lastError = null;
      updates.results   = [];
    }
    const item = await updatePublishQueueItem(id, updates);
    if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
    return NextResponse.json({ item });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const ok = await deletePublishQueueItem(id);
  if (!ok) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  return NextResponse.json({ success: true });
}
