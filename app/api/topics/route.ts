/**
 * app/api/topics/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET    /api/topics  — list all topic plans
 * POST   /api/topics  — add a new topic plan
 * PATCH  /api/topics  — update a topic plan
 * DELETE /api/topics  — delete a topic plan by id
 *
 * PATCH /api/topics with { id, action: "push_to_queue" }
 *   → creates a queue item from the topic plan
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getTopics,
  addTopicPlan,
  updateTopicPlan,
  deleteTopicPlan,
  addQueueItem,
  TopicPlan,
} from "@/lib/storage";

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const topics = await getTopics();
    console.log(`[topics:GET] ${topics.length} topics`);
    return NextResponse.json({ topics });
  } catch (err) {
    console.error("[topics:GET] Error:", err);
    return NextResponse.json({ error: "Failed to load topics" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json() as Partial<TopicPlan>;
    if (!body.topic?.trim()) {
      return NextResponse.json({ error: "topic is required" }, { status: 400 });
    }

    const plan = await addTopicPlan({
      topic:        body.topic.trim(),
      focusKeyword: body.focusKeyword?.trim() || "",
      cluster:      body.cluster?.trim() || "",
      intent:       body.intent?.trim() || "informational",
      priority:     typeof body.priority === "number" ? Math.min(5, Math.max(1, body.priority)) : 3,
      status:       "idea",
      notes:        body.notes?.trim() || "",
    });
    console.log(`[topics:POST] Added topic ${plan.id}: "${plan.topic}"`);
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    console.error("[topics:POST] Error:", err);
    return NextResponse.json({ error: "Failed to add topic" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { id, action, ...updates } = body;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    // Special action: push to generation queue
    if (action === "push_to_queue") {
      const topics = await getTopics();
      const plan = topics.find((t) => t.id === id);
      if (!plan) return NextResponse.json({ error: "Topic not found" }, { status: 404 });
      if (plan.status === "queued") {
        return NextResponse.json({ error: "Topic already queued" }, { status: 409 });
      }

      const queueItem = await addQueueItem(plan.topic, "topic_only", "", plan.priority);
      const updated = await updateTopicPlan(id, {
        status: "queued",
        queuedAt: new Date().toISOString(),
      });
      console.log(`[topics:PATCH] Pushed topic ${id} → queue item ${queueItem.id}`);
      return NextResponse.json({ plan: updated, queueItem });
    }

    const allowed = ["topic", "focusKeyword", "cluster", "intent", "priority", "status", "notes"];
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    const plan = await updateTopicPlan(id, safeUpdates);
    if (!plan) return NextResponse.json({ error: "Topic not found" }, { status: 404 });

    console.log(`[topics:PATCH] Updated topic ${id}`);
    return NextResponse.json({ plan });
  } catch (err) {
    console.error("[topics:PATCH] Error:", err);
    return NextResponse.json({ error: "Failed to update topic" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const ok = await deleteTopicPlan(id);
    if (!ok) return NextResponse.json({ error: "Topic not found" }, { status: 404 });

    console.log(`[topics:DELETE] Removed topic ${id}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[topics:DELETE] Error:", err);
    return NextResponse.json({ error: "Failed to delete topic" }, { status: 500 });
  }
}
