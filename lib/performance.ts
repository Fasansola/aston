/**
 * lib/performance.ts
 * ─────────────────────────────────────────────────────────────
 * Performance classification + sync helpers.
 */

import { fetchGSCData } from "./gsc";
import { fetchGA4Data } from "./ga4";
import {
  getQueue,
  getPerformance,
  upsertPostPerformance,
  type PostPerformance,
  type PerformanceClass,
} from "./storage";

// ── Classification ────────────────────────────────────────────

/**
 * Classify a post based on GSC metrics.
 *
 * High   — strong impressions + ranking in top 15 + decent CTR
 * Medium — some visibility or clicks
 * Low    — indexed but barely visible
 * Unknown — no data yet (too new or not indexed)
 */
export function classifyPerformance(metrics: {
  impressions: number;
  clicks: number;
  avgPosition: number;
  ctr: number;
}): PerformanceClass {
  if (metrics.impressions === 0) return "unknown";
  if (
    metrics.impressions >= 500 &&
    metrics.avgPosition <= 15 &&
    metrics.ctr >= 3
  ) return "high";
  if (metrics.impressions >= 100 || metrics.clicks >= 5) return "medium";
  return "low";
}

// ── Sync helpers ──────────────────────────────────────────────

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: string[];
}

/**
 * Sync performance data for all completed queue items that have a wpPostUrl.
 * Each post fetches from GSC (and optionally GA4) for the last 90 days.
 */
export async function syncAllPerformance(): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: [] };

  const queue = await getQueue();
  const completed = queue.filter(
    (item) => item.status === "completed" && item.wpPostUrl && item.wpPostId
  );

  if (completed.length === 0) {
    result.skipped = queue.filter((i) => i.status === "completed").length;
    return result;
  }

  const existing = await getPerformance();
  const existingMap = new Map(existing.map((p) => [p.postId, p]));

  for (const item of completed) {
    try {
      const url = item.wpPostUrl!;
      const urlObj = new URL(url);
      const pagePath = urlObj.pathname;

      const [gsc, ga4] = await Promise.all([
        fetchGSCData(url, 90),
        fetchGA4Data(pagePath, 90),
      ]);

      const prev = existingMap.get(String(item.wpPostId));

      const record: PostPerformance = {
        postId:        String(item.wpPostId),
        topic:         item.topic,
        url,
        focusKeyword:  prev?.focusKeyword ?? "",
        cluster:       prev?.cluster ?? "",
        publishedDate: item.completedAt ?? item.createdAt,
        lastSyncedAt:  new Date().toISOString(),
        // GSC
        impressions:   gsc?.impressions   ?? 0,
        clicks:        gsc?.clicks        ?? 0,
        avgPosition:   gsc?.avgPosition   ?? 0,
        ctr:           gsc?.ctr           ?? 0,
        // GA4
        pageviews:     ga4?.pageviews     ?? 0,
        sessions:      ga4?.sessions      ?? 0,
        avgTimeOnPage: ga4?.avgTimeOnPage ?? 0,
        bounceRate:    ga4?.bounceRate    ?? 0,
        // Classification
        classification: classifyPerformance({
          impressions: gsc?.impressions ?? 0,
          clicks:      gsc?.clicks      ?? 0,
          avgPosition: gsc?.avgPosition ?? 0,
          ctr:         gsc?.ctr         ?? 0,
        }),
      };

      await upsertPostPerformance(record);
      result.synced++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Post ${item.wpPostId}: ${msg}`);
    }
  }

  return result;
}

/**
 * Sync a single post by WP post ID.
 */
export async function syncOnePost(postId: string): Promise<PostPerformance | null> {
  const queue = await getQueue();
  const item = queue.find((i) => String(i.wpPostId) === postId && i.wpPostUrl);
  if (!item || !item.wpPostUrl) return null;

  const url = item.wpPostUrl;
  const urlObj = new URL(url);
  const pagePath = urlObj.pathname;

  const [gsc, ga4] = await Promise.all([
    fetchGSCData(url, 90),
    fetchGA4Data(pagePath, 90),
  ]);

  const existing = await getPerformance();
  const prev = existing.find((p) => p.postId === postId);

  const record: PostPerformance = {
    postId,
    topic:         item.topic,
    url,
    focusKeyword:  prev?.focusKeyword ?? "",
    cluster:       prev?.cluster      ?? "",
    publishedDate: item.completedAt   ?? item.createdAt,
    lastSyncedAt:  new Date().toISOString(),
    impressions:   gsc?.impressions   ?? 0,
    clicks:        gsc?.clicks        ?? 0,
    avgPosition:   gsc?.avgPosition   ?? 0,
    ctr:           gsc?.ctr           ?? 0,
    pageviews:     ga4?.pageviews     ?? 0,
    sessions:      ga4?.sessions      ?? 0,
    avgTimeOnPage: ga4?.avgTimeOnPage ?? 0,
    bounceRate:    ga4?.bounceRate    ?? 0,
    classification: classifyPerformance({
      impressions: gsc?.impressions ?? 0,
      clicks:      gsc?.clicks      ?? 0,
      avgPosition: gsc?.avgPosition ?? 0,
      ctr:         gsc?.ctr         ?? 0,
    }),
  };

  await upsertPostPerformance(record);
  return record;
}
