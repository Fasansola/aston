/**
 * lib/storage.ts
 * ─────────────────────────────────────────────────────────────
 * Persistent storage for queue items, scheduler settings, and
 * run logs.
 *
 * Primary:  Upstash Redis (production on Vercel)
 *           Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *           Install: vercel integration add upstash
 *
 * Fallback: File-based JSON (local dev without Redis configured)
 *           Data lives in data/queue.json, data/scheduler.json,
 *           data/runs.json — not suitable for Vercel serverless.
 */

import { GenerationMode } from "./source";

// ── Types ─────────────────────────────────────────────────────

export type QueueStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "paused";

export interface QueueItem {
  id: string;
  topic: string;
  mode: GenerationMode;
  sourceText: string;
  priority: number; // 1 (low) – 5 (high)
  status: QueueStatus;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
  lastError: string | null;
  wpPostId: number | null;
  wpEditUrl: string | null;
  qaScore: number | null;
  qaWarnings: string[];
}

export interface SchedulerSettings {
  enabled: boolean;
  blogsPerDay: number;
  publishMode: "draft_only";
  maxRetries: number;
}

export interface RunLog {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  topicsAttempted: number;
  topicsCompleted: number;
  topicsFailed: number;
  status: "running" | "completed" | "completed_with_errors" | "failed";
}

// ── Redis keys ────────────────────────────────────────────────

const KEYS = {
  queue: "aston:queue",
  settings: "aston:scheduler:settings",
  runs: "aston:runs",
} as const;

const DEFAULT_SETTINGS: SchedulerSettings = {
  enabled: false,
  blogsPerDay: 3,
  publishMode: "draft_only",
  maxRetries: 2,
};

// ── Storage adapter ───────────────────────────────────────────

async function getAdapter() {
  if (
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    const { Redis } = await import("@upstash/redis");
    return new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return null; // fall through to file adapter
}

// ── File adapter (local dev fallback) ────────────────────────

async function fileGet<T>(key: string, fallback: T): Promise<T> {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const file = path.join(process.cwd(), "data", `${key.replace(/[:/]/g, "_")}.json`);
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function fileSet<T>(key: string, value: T): Promise<void> {
  const { default: fs } = await import("fs");
  const { default: path } = await import("path");
  const dir = path.join(process.cwd(), "data");
  const file = path.join(dir, `${key.replace(/[:/]/g, "_")}.json`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

// ── Generic get / set ─────────────────────────────────────────

async function kget<T>(key: string, fallback: T): Promise<T> {
  const redis = await getAdapter();
  if (redis) {
    const val = await redis.get<T>(key);
    return val ?? fallback;
  }
  return fileGet(key, fallback);
}

async function kset<T>(key: string, value: T): Promise<void> {
  const redis = await getAdapter();
  if (redis) {
    await redis.set(key, value);
    return;
  }
  return fileSet(key, value);
}

// ── Queue ─────────────────────────────────────────────────────

export async function getQueue(): Promise<QueueItem[]> {
  return kget<QueueItem[]>(KEYS.queue, []);
}

export async function saveQueue(items: QueueItem[]): Promise<void> {
  return kset(KEYS.queue, items);
}

export async function addQueueItem(
  topic: string,
  mode: GenerationMode = "topic_only",
  sourceText = "",
  priority = 3
): Promise<QueueItem> {
  const item: QueueItem = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    topic,
    mode,
    sourceText,
    priority,
    status: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    retryCount: 0,
    lastError: null,
    wpPostId: null,
    wpEditUrl: null,
    qaScore: null,
    qaWarnings: [],
  };
  const queue = await getQueue();
  queue.push(item);
  await saveQueue(queue);
  return item;
}

export async function updateQueueItem(
  id: string,
  updates: Partial<QueueItem>
): Promise<QueueItem | null> {
  const queue = await getQueue();
  const idx = queue.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  queue[idx] = { ...queue[idx], ...updates };
  await saveQueue(queue);
  return queue[idx];
}

export async function deleteQueueItem(id: string): Promise<boolean> {
  const queue = await getQueue();
  const next = queue.filter((i) => i.id !== id);
  if (next.length === queue.length) return false;
  await saveQueue(next);
  return true;
}

/** Return next item eligible for processing — highest priority, then oldest. */
export async function getNextEligibleItem(): Promise<QueueItem | null> {
  const queue = await getQueue();
  return (
    queue
      .filter((i) => i.status === "queued")
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt.localeCompare(b.createdAt);
      })[0] ?? null
  );
}

// ── Scheduler settings ────────────────────────────────────────

export async function getSettings(): Promise<SchedulerSettings> {
  return kget<SchedulerSettings>(KEYS.settings, DEFAULT_SETTINGS);
}

export async function saveSettings(
  settings: SchedulerSettings
): Promise<void> {
  return kset(KEYS.settings, settings);
}

// ── Run logs ──────────────────────────────────────────────────

export async function getRuns(limit = 20): Promise<RunLog[]> {
  const all = await kget<RunLog[]>(KEYS.runs, []);
  return all.slice(-limit);
}

export async function addRunLog(log: RunLog): Promise<void> {
  const all = await kget<RunLog[]>(KEYS.runs, []);
  all.push(log);
  return kset(KEYS.runs, all.slice(-100)); // keep last 100
}

export async function updateRunLog(
  runId: string,
  updates: Partial<RunLog>
): Promise<void> {
  const all = await kget<RunLog[]>(KEYS.runs, []);
  const idx = all.findIndex((r) => r.runId === runId);
  if (idx !== -1) {
    all[idx] = { ...all[idx], ...updates };
    await kset(KEYS.runs, all);
  }
}

// ── Quota helpers ─────────────────────────────────────────────

export async function completedTodayCount(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const queue = await getQueue();
  return queue.filter(
    (i) => i.status === "completed" && i.completedAt?.startsWith(today)
  ).length;
}
