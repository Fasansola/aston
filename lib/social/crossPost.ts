/**
 * lib/social/crossPost.ts
 * Shared helper that cross-posts a published queue item to its social targets.
 * Used by both the cron worker (app/api/cron-publish) and the manual
 * publish-now path, so the two stay in lockstep.
 *
 * Deliberately does NO LLM work: captions are generated up front (at enqueue
 * time, via /api/social/captions) and stored on the item, so the publish worker
 * stays fast and within its function budget. If a caption is missing for a
 * target, we fall back to the article excerpt.
 */

import { getSocialConnector, isSocialTarget } from "@/lib/social/registry";
import type { PublishQueueItem, PublishQueueResult } from "@/lib/storage";

/** The public URL to link back to from social — the canonical blog URL, else the first published URL. */
export function resolveSocialLink(item: PublishQueueItem): string | undefined {
  if (item.canonicalUrl) return item.canonicalUrl;
  const passed = (item.results ?? []).find((r) => r.ok && r.externalUrl);
  return passed?.externalUrl;
}

export async function crossPostQueueItem(item: PublishQueueItem): Promise<PublishQueueResult[]> {
  const socialTargets = item.socialTargets ?? [];
  if (socialTargets.length === 0) return [];

  const link = resolveSocialLink(item);
  const fallbackText = (item.excerpt || item.seoTitle || item.title).trim();
  const mediaUrls = item.featuredImageUrl ? [item.featuredImageUrl] : [];

  return Promise.all(
    socialTargets.map(async ({ target, config }): Promise<PublishQueueResult> => {
      if (!isSocialTarget(target)) {
        return { target, ok: false, status: "failed", message: `Unknown social target "${target}"` };
      }
      const connector = getSocialConnector(target);
      const validation = await connector.validateConfig(config);
      if (!validation.ok) {
        return { target, ok: false, status: "failed", message: `Config invalid: ${validation.errors.join("; ")}` };
      }
      const text = item.socialCaptions?.[target]?.trim() || fallbackText;
      const res = await connector.publish({
        target,
        targetConfig: config,
        post: { text, link, mediaUrls, altTexts: [] },
      });
      return {
        target: res.target,
        ok: res.ok,
        status: res.status,
        message: res.message,
        externalUrl: res.externalUrl,
      };
    })
  );
}
