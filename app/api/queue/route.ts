/**
 * app/api/queue/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET    /api/queue  — list all queue items + stats
 * POST   /api/queue  — add a new item
 * PATCH  /api/queue  — update an item (status / priority / topic)
 * DELETE /api/queue  — remove an item by id
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getQueue,
  addQueueItem,
  updateQueueItem,
  deleteQueueItem,
  completedTodayCount,
} from "@/lib/storage";
import { GenerationMode } from "@/lib/source";

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

// ── GET ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[queue:GET] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [queue, completedToday] = await Promise.all([
      getQueue(),
      completedTodayCount(),
    ]);

    const stats = {
      total: queue.length,
      queued: queue.filter((i) => i.status === "queued").length,
      processing: queue.filter((i) => i.status === "processing").length,
      completed: queue.filter((i) => i.status === "completed").length,
      failed: queue.filter((i) => i.status === "failed").length,
      paused: queue.filter((i) => i.status === "paused").length,
      completedToday,
    };

    console.log(`[queue:GET] ${queue.length} items, ${stats.queued} queued, ${completedToday} done today`);
    return NextResponse.json({ items: queue, stats });
  } catch (err) {
    console.error("[queue:GET] Error:", err);
    return NextResponse.json({ error: "Failed to load queue" }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[queue:POST] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      topic,
      mode = "topic_only",
      sourceText = "",
      priority = 3,
      audience = "",
      primary_country = "",
      secondary_countries = "",
      priority_service = "",
      language = "",
    }: {
      topic: string;
      mode: GenerationMode;
      sourceText: string;
      priority: number;
      audience: string;
      primary_country: string;
      secondary_countries: string;
      priority_service: string;
      language: string;
    } = body;

    if (!topic?.trim()) {
      return NextResponse.json({ error: "topic is required" }, { status: 400 });
    }
    if (!audience?.trim()) {
      return NextResponse.json({ error: "audience is required" }, { status: 400 });
    }
    if (priority < 1 || priority > 5) {
      return NextResponse.json(
        { error: "priority must be between 1 and 5" },
        { status: 400 }
      );
    }

    const item = await addQueueItem(topic.trim(), mode, sourceText, priority, {
      audience: audience || undefined,
      primary_country: primary_country || undefined,
      secondary_countries: secondary_countries || undefined,
      priority_service: priority_service || undefined,
      language: language || undefined,
    });
    console.log(`[queue:POST] Added item ${item.id}: "${item.topic}" (mode: ${mode}, priority: ${priority})`);
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    console.error("[queue:POST] Error:", err);
    return NextResponse.json({ error: "Failed to add queue item" }, { status: 500 });
  }
}

// ── PATCH ─────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[queue:PATCH] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    // Only allow safe client-facing fields
    const allowed = ["status", "priority", "topic"];
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    const item = await updateQueueItem(id, safeUpdates);
    if (!item) {
      console.warn(`[queue:PATCH] Item not found: ${id}`);
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    console.log(`[queue:PATCH] Updated item ${id}:`, safeUpdates);
    return NextResponse.json({ item });
  } catch (err) {
    console.error("[queue:PATCH] Error:", err);
    return NextResponse.json({ error: "Failed to update queue item" }, { status: 500 });
  }
}

// ── DELETE ────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) {
    console.warn("[queue:DELETE] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await req.json();
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const ok = await deleteQueueItem(id);
    if (!ok) {
      console.warn(`[queue:DELETE] Item not found: ${id}`);
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    console.log(`[queue:DELETE] Removed item ${id}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[queue:DELETE] Error:", err);
    return NextResponse.json({ error: "Failed to delete queue item" }, { status: 500 });
  }
}
