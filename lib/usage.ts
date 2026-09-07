/**
 * lib/usage.ts
 * ─────────────────────────────────────────────────────────────
 * Token-usage accounting for every OpenAI call.
 *
 * lib/llm.ts reports each successful call to a listener; this module owns
 * that listener and an AsyncLocalStorage context so calls made inside a
 * workflow step (or a route) are attributed to the right run, then flushed
 * to Redis as atomic hash increments:
 *
 *   aston:usage:run:<runLogId>   — one hash per scheduled run (90-day TTL)
 *   aston:usage:month:<YYYY-MM>  — rolling monthly totals (never expires)
 *
 * Fields: calls, images, in, out, reasoning, plus per-model variants
 * (calls:<model>, images:<model>, in:<model>, out:<model>) so a cost estimate
 * can be computed from an OPENAI_PRICING price table when one is configured.
 *
 * Why this lives apart from lib/llm.ts: node:async_hooks must stay out of the
 * workflow bundle, and lib/llm.ts is (transitively) imported there. This
 * module is only ever loaded dynamically from step bodies and routes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { setUsageListener, type LlmUsageRecord } from "./llm";
import { khincrby, khgetall, kexpire, type UsageTotals } from "./storage";

interface UsageStore {
  runLogId?: string;
  step: string;
  records: LlmUsageRecord[];
}

const als = new AsyncLocalStorage<UsageStore>();
setUsageListener((rec) => { als.getStore()?.records.push(rec); });

const RUN_KEY = (id: string) => `aston:usage:run:${id}`;
const MONTH_KEY = (month: string) => `aston:usage:month:${month}`;
const RUN_TTL_SECS = 90 * 86_400;

/** "YYYY-MM" for the given date (UTC). */
export function monthKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Run `fn` with usage attribution. Every chatWithRetry/recordUsage call made
 * (transitively) inside it is collected and flushed when it settles — on
 * success AND failure, since tokens spent before a failure are still spent.
 */
export async function withUsageContext<T>(ctx: { runLogId?: string; step: string }, fn: () => Promise<T>): Promise<T> {
  const store: UsageStore = { runLogId: ctx.runLogId, step: ctx.step, records: [] };
  try {
    return await als.run(store, fn);
  } finally {
    if (store.records.length > 0) {
      await flushRecords(store.records, store.runLogId).catch((err) =>
        console.warn(`[usage] flush failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  }
}

function aggregate(records: LlmUsageRecord[]): Record<string, number> {
  const inc: Record<string, number> = {};
  const add = (field: string, n: number) => { if (n > 0) inc[field] = (inc[field] ?? 0) + n; };
  for (const r of records) {
    if (r.kind === "image") { add("images", 1); add(`images:${r.model}`, 1); }
    else { add("calls", 1); add(`calls:${r.model}`, 1); }
    add("in", r.promptTokens);
    add("out", r.completionTokens);
    add("reasoning", r.reasoningTokens);
    add(`in:${r.model}`, r.promptTokens);
    add(`out:${r.model}`, r.completionTokens);
  }
  return inc;
}

async function flushRecords(records: LlmUsageRecord[], runLogId?: string): Promise<void> {
  const inc = aggregate(records);
  const keys = [MONTH_KEY(monthKey())];
  if (runLogId) keys.push(RUN_KEY(runLogId));
  for (const key of keys) {
    for (const [field, by] of Object.entries(inc)) {
      await khincrby(key, field, by);
    }
  }
  if (runLogId) await kexpire(RUN_KEY(runLogId), RUN_TTL_SECS);
}

// ── Reading totals ────────────────────────────────────────────

/**
 * Optional price table, USD per 1M tokens, e.g.
 *   OPENAI_PRICING={"gpt-5.5":{"input":1.25,"output":10},"gpt-4o":{"input":2.5,"output":10}}
 * Prices change; keeping them in env avoids shipping stale numbers in code.
 */
function priceTable(): Record<string, { input: number; output: number }> | null {
  const raw = process.env.OPENAI_PRICING?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, { input?: number; output?: number }>;
    const out: Record<string, { input: number; output: number }> = {};
    for (const [model, p] of Object.entries(parsed)) {
      if (p && typeof p.input === "number" && typeof p.output === "number") out[model] = { input: p.input, output: p.output };
    }
    return Object.keys(out).length ? out : null;
  } catch {
    console.warn("[usage] OPENAI_PRICING is not valid JSON — cost estimates disabled");
    return null;
  }
}

export function estimateCostUsd(byModel: UsageTotals["byModel"]): number | null {
  const prices = priceTable();
  if (!prices) return null;
  let usd = 0;
  let priced = false;
  for (const [model, m] of Object.entries(byModel)) {
    const p = prices[model];
    if (!p) continue;
    priced = true;
    usd += (m.promptTokens / 1_000_000) * p.input + (m.completionTokens / 1_000_000) * p.output;
  }
  return priced ? Math.round(usd * 100) / 100 : null;
}

export function totalsFromHash(h: Record<string, number> | null | undefined): UsageTotals {
  const n = (k: string) => Number(h?.[k] ?? 0) || 0;
  const byModel: UsageTotals["byModel"] = {};
  for (const key of Object.keys(h ?? {})) {
    const idx = key.indexOf(":");
    if (idx === -1) continue;
    const field = key.slice(0, idx);
    const model = key.slice(idx + 1);
    if (!model) continue;
    byModel[model] ??= { calls: 0, images: 0, promptTokens: 0, completionTokens: 0 };
    if (field === "calls")  byModel[model].calls = n(key);
    if (field === "images") byModel[model].images = n(key);
    if (field === "in")     byModel[model].promptTokens = n(key);
    if (field === "out")    byModel[model].completionTokens = n(key);
  }
  const totals: UsageTotals = {
    calls: n("calls"),
    images: n("images"),
    promptTokens: n("in"),
    completionTokens: n("out"),
    reasoningTokens: n("reasoning"),
    totalTokens: n("in") + n("out"),
    byModel,
    estimatedCostUsd: null,
  };
  totals.estimatedCostUsd = estimateCostUsd(byModel);
  return totals;
}

export async function getRunUsage(runLogId: string): Promise<UsageTotals | null> {
  const h = await khgetall(RUN_KEY(runLogId));
  if (!h || Object.keys(h).length === 0) return null;
  return totalsFromHash(h);
}

export async function getMonthlyUsage(month: string = monthKey()): Promise<UsageTotals> {
  return totalsFromHash(await khgetall(MONTH_KEY(month)));
}

/** OPENAI_MONTHLY_TOKEN_BUDGET (total tokens per calendar month), or null when unset. */
export function monthlyTokenBudget(): number | null {
  const raw = process.env.OPENAI_MONTHLY_TOKEN_BUDGET?.trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[_,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Human-friendly token count: 12.3k, 1.4M. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
