import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QueueItem } from "@/lib/storage";

// A fake Upstash client whose behaviour each test sets.
const redis = {
  get: vi.fn(),
  set: vi.fn(),
};
vi.mock("@upstash/redis", () => ({ Redis: vi.fn(function () { return redis; }) }));

const LIMIT_ERR = "ERR This database has reached current Fixed plan limits. Please upgrade manually or enable auto upgrade on Upstash Console";

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "q_1", topic: "UAE VAT", mode: "topic_only", sourceText: "", priority: 3, status: "queued",
    createdAt: "2026-11-01T08:00:00.000Z", completedAt: null, retryCount: 0, lastError: null,
    wpPostId: null, wpEditUrl: null, wpPostUrl: null, qaScore: null, qaWarnings: [],
    ...over,
  };
}

describe("storage with Upstash", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    redis.get.mockReset();
    redis.set.mockReset();
  });
  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("returns the fallback only for a missing key, and throws when Redis refuses the read", async () => {
    const { kget } = await import("@/lib/storage");
    redis.get.mockResolvedValueOnce(null);
    await expect(kget("aston:queue", [])).resolves.toEqual([]);
    redis.get.mockRejectedValueOnce(new Error(LIMIT_ERR));
    await expect(kget("aston:queue", [])).rejects.toThrow(/Storage read failed for "aston:queue".*Fixed plan limits/);
  });

  it("never saves over the queue when the queue read fails", async () => {
    const { addQueueItem, updateQueueItem } = await import("@/lib/storage");
    redis.get.mockRejectedValue(new Error(LIMIT_ERR));
    await expect(addQueueItem("New topic")).rejects.toThrow(/Storage read failed/);
    await expect(updateQueueItem("q_1", { priority: 5 })).rejects.toThrow(/Storage read failed/);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("does not re-seed the link list from the static file when the read fails", async () => {
    const { getLinks } = await import("@/lib/storage");
    redis.get.mockRejectedValueOnce(new Error(LIMIT_ERR));
    await expect(getLinks()).rejects.toThrow(/Storage read failed/);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("drops completed items' briefs on save, but keeps them on items that can still run", async () => {
    const { saveQueue } = await import("@/lib/storage");
    const brief = "x".repeat(22_000);
    await saveQueue([
      item({ id: "done", status: "completed", customPrompt: brief, sourceText: "source", wpPostUrl: "https://aston.ae/a/" }),
      item({ id: "waiting", status: "queued", customPrompt: brief }),
      item({ id: "failed", status: "failed", customPrompt: brief, sourceText: "source" }),
    ]);
    const saved = redis.set.mock.calls[0][1] as QueueItem[];
    const byId = Object.fromEntries(saved.map((i) => [i.id, i]));
    expect(byId.done.customPrompt).toBeUndefined();
    expect(byId.done.sourceText).toBe("");
    expect(byId.done.wpPostUrl).toBe("https://aston.ae/a/"); // performance sync still needs this
    expect(byId.waiting.customPrompt).toBe(brief);
    expect(byId.failed.customPrompt).toBe(brief);
    expect(byId.failed.sourceText).toBe("source");
  });

  it("compacts an old queue once, and never while a run is processing", async () => {
    const { compactQueueIfIdle } = await import("@/lib/storage");
    const stale = item({ id: "done", status: "completed", customPrompt: "brief" });
    await expect(compactQueueIfIdle([stale, item({ id: "p", status: "processing" })])).resolves.toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    await expect(compactQueueIfIdle([stale, item({ id: "w" })])).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const compacted = redis.set.mock.calls[0][1] as QueueItem[];
    await expect(compactQueueIfIdle(compacted)).resolves.toBe(false);
  });

  it("recovers stuck items in the array it was given, without re-reading the queue", async () => {
    const { recoverStuckProcessingItems } = await import("@/lib/storage");
    const queue = [item({ id: "stuck", status: "processing", processingStartedAt: "2026-01-01T00:00:00.000Z" })];
    redis.set.mockResolvedValue("OK");
    await expect(recoverStuckProcessingItems(2, queue)).resolves.toBe(1);
    expect(redis.get).not.toHaveBeenCalled();
    expect(queue[0].status).toBe("queued");
  });
});

describe("queue helpers", () => {
  it("counts only items completed on the given UTC day", async () => {
    const { countCompletedToday } = await import("@/lib/storage");
    const now = new Date("2026-11-10T13:00:00.000Z");
    expect(countCompletedToday([
      item({ status: "completed", completedAt: "2026-11-10T08:10:00.000Z" }),
      item({ status: "completed", completedAt: "2026-11-09T23:59:00.000Z" }),
      item({ status: "failed", completedAt: "2026-11-10T09:00:00.000Z" }),
    ], now)).toBe(1);
  });
});

describe("storage hint on the status card", () => {
  it("explains the Upstash plan limit and points at the console", async () => {
    const { storageHint } = await import("@/lib/health");
    expect(storageHint(`Storage write failed for "aston:health:ping": ${LIMIT_ERR}`)).toMatch(/monthly limit.*Auto Upgrade/);
    expect(storageHint("ERR DB capacity quota exceeded")).toMatch(/full/);
    expect(storageHint("fetch failed")).toBeUndefined();
  });
});
