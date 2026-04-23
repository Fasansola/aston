/**
 * app/api/publish-now/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/publish-now — immediately publish a single queued item
 *
 * Body: { id: string }
 * Auth: x-api-secret header (same as other admin endpoints)
 */

import { NextRequest, NextResponse } from "next/server";
import { getPublishQueue, updatePublishQueueItem } from "@/lib/storage";
import { getConnector } from "@/lib/publishers/registry";
import { htmlToMarkdown } from "@/lib/publishers/htmlToMarkdown";
import type { PublishRequest } from "@/lib/publishers/types";
import type { PublishQueueTarget } from "@/lib/storage";

export const maxDuration = 60;

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  console.log("[publish-now] POST invoked");
  if (!authOk(req)) {
    console.warn("[publish-now] Unauthorized request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const queue = await getPublishQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (item.status === "processing") return NextResponse.json({ error: "Already processing" }, { status: 409 });
  if (item.status === "published") return NextResponse.json({ error: "Already published" }, { status: 409 });

  await updatePublishQueueItem(id, { status: "processing" });
  console.log(`[publish-now] Starting instant publish for "${item.title}" (${id}) → ${item.targets.map((t) => t.target).join(", ")}`);

  try {
    const markdown = htmlToMarkdown(item.articleHtml);

    const results = await Promise.all(
      item.targets.map(async ({ target, config }: PublishQueueTarget) => {
        const connector = getConnector(target as Parameters<typeof getConnector>[0]);

        const validation = await connector.validateConfig(config);
        if (!validation.ok) {
          return {
            target,
            ok: false,
            status: "failed" as const,
            message: `Config invalid: ${validation.errors.join("; ")}`,
          };
        }

        const request: PublishRequest = {
          title:            item.title,
          excerpt:          item.excerpt,
          html:             item.articleHtml,
          markdown,
          tags:             item.tags,
          seoTitle:         item.seoTitle,
          seoDescription:   item.metaDescription,
          canonicalUrl:     item.canonicalUrl,
          featuredImageUrl: undefined,
          target:           target as PublishRequest["target"],
          targetConfig:     config,
        };

        return connector.publish(request);
      })
    );

    const allPassed = results.every((r) => r.ok);
    const newStatus = allPassed ? "published" : results.some((r) => r.ok) ? "published" : "failed";

    const updated = await updatePublishQueueItem(id, {
      status:      newStatus,
      processedAt: new Date().toISOString(),
      results,
      lastError:   allPassed ? null : results.filter((r) => !r.ok).map((r) => r.message).join("; "),
    });

    return NextResponse.json({ success: true, status: newStatus, item: updated, results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await updatePublishQueueItem(id, { status: "failed", lastError: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
