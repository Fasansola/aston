/**
 * lib/storage.ts
 * ─────────────────────────────────────────────────────────────
 * Persistent storage for queue items, scheduler settings,
 * run logs, link manager, and topic planner.
 *
 * Primary:  Upstash Redis (production on Vercel)
 *           Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *
 * Fallback: File-based JSON (local dev without Redis configured)
 *           Data lives in data/*.json — not for Vercel serverless.
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
  wpPostUrl: string | null;
  qaScore: number | null;
  qaWarnings: string[];
  // Strategy engine inputs (optional — added in v2)
  audience?: string;
  primary_country?: string;
  secondary_countries?: string;
  priority_service?: string;
  language?: string;
}

export interface SchedulerSettings {
  enabled: boolean;
  blogsPerDay: number;
  publishMode: "draft_only";
  maxRetries: number;
  blockOnQaWarning: boolean;
  maxPerRun: number;
  runHour: number; // 0–23 UTC — cron fires hourly, only processes at this hour
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

// ── Link Manager types ────────────────────────────────────────

export interface LinkEntry {
  id: string;
  url: string;
  title: string;
  type: "internal" | "external";
  category: string;
  keywords: string[];
  anchors: string[];
  status: "active" | "inactive";
}

// ── Topic Planner types ───────────────────────────────────────

export type TopicPlanStatus =
  | "idea"
  | "planned"
  | "approved"
  | "queued"
  | "archived";

export interface TopicPlan {
  id: string;
  topic: string;
  focusKeyword: string;
  cluster: string;
  intent: string;
  priority: number; // 1–5
  status: TopicPlanStatus;
  notes: string;
  createdAt: string;
  queuedAt: string | null;
}

// ── Redis keys ────────────────────────────────────────────────

const KEYS = {
  queue:    "aston:queue",
  settings: "aston:scheduler:settings",
  runs:     "aston:runs",
  links:    "aston:links",
  topics:   "aston:topics",
} as const;

const DEFAULT_SETTINGS: SchedulerSettings = {
  enabled: false,
  blogsPerDay: 3,
  publishMode: "draft_only",
  maxRetries: 2,
  blockOnQaWarning: false,
  maxPerRun: 1,
  runHour: 8,
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
  priority = 3,
  strategyInputs?: {
    audience?: string;
    primary_country?: string;
    secondary_countries?: string;
    priority_service?: string;
    language?: string;
  }
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
    wpPostUrl: null,
    qaScore: null,
    qaWarnings: [],
    ...(strategyInputs ?? {}),
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

// ── Performance Tracking ──────────────────────────────────────

export type PerformanceClass = "high" | "medium" | "low" | "unknown";

export interface PostPerformance {
  postId: string;          // WP post ID (string)
  topic: string;
  url: string;             // frontend URL
  focusKeyword: string;
  cluster: string;
  publishedDate: string;
  lastSyncedAt: string;
  // GSC metrics
  impressions: number;
  clicks: number;
  avgPosition: number;
  ctr: number;             // percentage e.g. 4.2
  // GA4 metrics (0 if not configured)
  pageviews: number;
  sessions: number;
  avgTimeOnPage: number;   // seconds
  bounceRate: number;      // percentage
  // Classification
  classification: PerformanceClass;
}

export async function getPerformance(): Promise<PostPerformance[]> {
  return kget<PostPerformance[]>("aston:performance", []);
}

export async function upsertPostPerformance(record: PostPerformance): Promise<void> {
  const all = await getPerformance();
  const idx = all.findIndex((p) => p.postId === record.postId);
  if (idx === -1) all.push(record);
  else all[idx] = record;
  await kset("aston:performance", all);
}

// ── Link Manager ──────────────────────────────────────────────

/** Returns all links. Seeds from data/links.json on first call. */
export async function getLinks(): Promise<LinkEntry[]> {
  const stored = await kget<LinkEntry[] | null>(KEYS.links, null);
  if (stored !== null) return stored;

  // First-time seed from the static JSON file
  try {
    const { default: data } = await import("@/data/links.json");
    const seeded: LinkEntry[] = [
      ...(data.internal as Omit<LinkEntry, "type">[]).map((l) => ({ ...l, type: "internal" as const })),
      ...(data.external as Omit<LinkEntry, "type">[]).map((l) => ({ ...l, type: "external" as const })),
    ];
    await kset(KEYS.links, seeded);
    return seeded;
  } catch {
    return [];
  }
}

export async function saveLinks(links: LinkEntry[]): Promise<void> {
  return kset(KEYS.links, links);
}

export async function addLink(link: Omit<LinkEntry, "id">): Promise<LinkEntry> {
  const links = await getLinks();
  const newLink: LinkEntry = {
    ...link,
    id: `link_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
  links.push(newLink);
  await saveLinks(links);
  return newLink;
}

export async function updateLink(
  id: string,
  updates: Partial<LinkEntry>
): Promise<LinkEntry | null> {
  const links = await getLinks();
  const idx = links.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  links[idx] = { ...links[idx], ...updates };
  await saveLinks(links);
  return links[idx];
}

export async function deleteLink(id: string): Promise<boolean> {
  const links = await getLinks();
  const next = links.filter((l) => l.id !== id);
  if (next.length === links.length) return false;
  await saveLinks(next);
  return true;
}

// ── Topic Planner ─────────────────────────────────────────────

export async function getTopics(): Promise<TopicPlan[]> {
  return kget<TopicPlan[]>(KEYS.topics, []);
}

export async function addTopicPlan(
  data: Omit<TopicPlan, "id" | "createdAt" | "queuedAt">
): Promise<TopicPlan> {
  const plan: TopicPlan = {
    ...data,
    id: `tp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    queuedAt: null,
  };
  const all = await getTopics();
  all.push(plan);
  await kset(KEYS.topics, all);
  return plan;
}

export async function updateTopicPlan(
  id: string,
  updates: Partial<TopicPlan>
): Promise<TopicPlan | null> {
  const all = await getTopics();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates };
  await kset(KEYS.topics, all);
  return all[idx];
}

export async function deleteTopicPlan(id: string): Promise<boolean> {
  const all = await getTopics();
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  await kset(KEYS.topics, next);
  return true;
}
