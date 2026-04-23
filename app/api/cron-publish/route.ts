/**
 * app/api/cron-publish/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/cron-publish — invoked by Vercel Cron every hour (see vercel.json)
 *
 * On each run:
 *  1. Fetch all publish queue items that are due (scheduledFor <= now or null)
 *  2. For each item, dispatch to all configured targets via publisher connectors
 *  3. Update item status — "published" (all passed), "failed", or partial results
 *  4. Retry up to 2 times on failure before marking permanently failed
 *
 * Vercel Cron passes the CRON_SECRET as a Bearer token.
 * Set CRON_SECRET in your Vercel project env vars.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDuePublishItems, updatePublishQueueItem } from "@/lib/storage";
import { getConnector } from "@/lib/publishers/registry";
import { htmlToMarkdown } from "@/lib/publishers/htmlToMarkdown";
import type { PublishRequest } from "@/lib/publishers/types";
import type { PublishQueueTarget } from "@/lib/storage";

export const maxDuration = 60;

const MAX_RETRIES = 2;
const MAX_PER_RUN = 5;

function authOk(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId   = `prun_${Date.now()}`;
  const startedAt = new Date().toISOString();
  let attempted = 0, published = 0, failed = 0;

  console.log(`[cron-publish:${runId}] Starting — checking for due publish items`);

  const dueItems = await getDuePublishItems(MAX_PER_RUN);
  console.log(`[cron-publish:${runId}] ${dueItems.length} item(s) due`);

  for (const item of dueItems) {
    attempted++;
    console.log(`[cron-publish:${runId}] Processing "${item.title}" (${item.id}) → ${item.targets.map((t) => t.target).join(", ")}`);

    // Mark as processing
    await updatePublishQueueItem(item.id, { status: "processing" });

    try {
      const markdown = htmlToMarkdown(item.articleHtml);

      const results = await Promise.all(
        item.targets.map(async ({ target, config }: PublishQueueTarget) => {
          const connector = getConnector(target as Parameters<typeof getConnector>[0]);

          // Validate config first
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
            title:          item.title,
            excerpt:        item.excerpt,
            html:           item.articleHtml,
            markdown,
            tags:           item.tags,
            seoTitle:       item.seoTitle,
            seoDescription: item.metaDescription,
            canonicalUrl:   item.canonicalUrl,
            featuredImageUrl: undefined,
            target:         target as PublishRequest["target"],
            targetConfig:   config,
          };

          const result = await connector.publish(request);
          console.log(`[cron-publish:${runId}] ${target}: ${result.status}${result.externalUrl ? ` → ${result.externalUrl}` : ""}`);
          return result;
        })
      );

      const allPassed = results.every((r) => r.ok);
      const newStatus = allPassed ? "published" : results.some((r) => r.ok) ? "published" : "failed";

      await updatePublishQueueItem(item.id, {
        status:      newStatus,
        processedAt: new Date().toISOString(),
        results,
        lastError:   allPassed ? null : results.filter((r) => !r.ok).map((r) => r.message).join("; "),
      });

      if (newStatus === "published") {
        published++;
        console.log(`[cron-publish:${runId}] ✓ Published "${item.title}"`);
      } else {
        failed++;
        console.warn(`[cron-publish:${runId}] ✗ Failed "${item.title}" — some targets failed`);
      }
    } catch (err: unknown) {
      failed++;
      const message = err instanceof Error ? err.message : "Unknown error";
      const newRetryCount = item.retryCount + 1;
      const exhausted = newRetryCount >= MAX_RETRIES;

      console.error(`[cron-publish:${runId}] Error processing "${item.title}": ${message} (retry ${newRetryCount}/${MAX_RETRIES})`);

      await updatePublishQueueItem(item.id, {
        status:     exhausted ? "failed" : "queued",
        retryCount: newRetryCount,
        lastError:  message,
      });
    }
  }

  const summary = { runId, startedAt, completedAt: new Date().toISOString(), attempted, published, failed };
  console.log(`[cron-publish:${runId}] Done — ${published} published, ${failed} failed`);

  return NextResponse.json({ success: true, ...summary });
}
