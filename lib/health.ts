/**
 * lib/health.ts
 * ─────────────────────────────────────────────────────────────
 * Cheap, time-bounded checks of everything a generation needs, used by:
 *
 *  - GET /api/health          → the dashboard's "System status" card
 *  - the cron dispatcher      → pre-flight before starting a workflow, so a
 *                               dead OpenAI account fails an item in seconds
 *                               with a plain-English reason instead of after
 *                               minutes of doomed retries
 *
 * Each check is independent and never throws. Only OpenAI (non-retryable
 * failure), storage and the token budget can BLOCK generation; WordPress is
 * reported but never blocks, because its anti-bot block is intermittent and
 * publishing happens ~10 minutes after the check anyway.
 */

import OpenAI from "openai";
import { PRIMARY_MODEL, FALLBACK_MODEL, classifyLlmError, errorMessage } from "./llm";
import { WP_API_BASE, WP_API_VIA_RELAY, WP_HEADERS, WP_RELAY_KEY } from "./wpApi";
import { isSgCaptcha } from "./wordpress";
import { getSettings, kset, type UsageTotals } from "./storage";
import { getMonthlyUsage, monthlyTokenBudget, formatTokens, monthKey } from "./usage";

export type HealthStatus = "ok" | "warn" | "fail";

export interface HealthCheck {
  status: HealthStatus;
  /** One line: what was checked and what came back. */
  message: string;
  /** What to do about it, when not ok. */
  hint?: string;
  ms?: number;
  /** True when this result should stop new generations from starting. */
  blocking?: boolean;
}

export interface HealthReport {
  checkedAt: string;
  canGenerate: boolean;
  blockers: string[];
  openai: HealthCheck;
  wordpress: HealthCheck;
  storage: HealthCheck;
  alerts: HealthCheck;
  budget: HealthCheck;
  usage: UsageTotals | null;
  usageMonth: string;
  wpApiViaRelay: boolean;
}


/** A real (tiny) completion — model listing succeeds even with zero credits, a completion does not. */
export async function checkOpenAI(timeoutMs = 30_000): Promise<HealthCheck> {
  if (!process.env.OPENAI_API_KEY) {
    return { status: "fail", message: "OPENAI_API_KEY is not set", hint: "Add it in Vercel → Settings → Environment Variables.", blocking: true };
  }
  const t0 = Date.now();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const ping = (model: string) => openai.chat.completions.create(
    { model, messages: [{ role: "user", content: "Reply with OK." }], max_completion_tokens: 32 },
    { signal: AbortSignal.timeout(timeoutMs) }
  );
  try {
    await ping(PRIMARY_MODEL);
    return { status: "ok", message: `${PRIMARY_MODEL} responded`, ms: Date.now() - t0 };
  } catch (err) {
    const fatal = classifyLlmError(err);
    if (fatal?.kind === "model" && FALLBACK_MODEL !== PRIMARY_MODEL) {
      // Same degradation chatWithRetry applies: the run works on the fallback,
      // so this is a warning for the operator, not a blocker.
      try {
        await ping(FALLBACK_MODEL);
        return {
          status: "warn",
          message: `${PRIMARY_MODEL} is not available on this account; generation is using ${FALLBACK_MODEL} instead`,
          hint: `Set OPENAI_MODEL in Vercel → Settings → Environment Variables to a model the account can use, or enable ${PRIMARY_MODEL} at platform.openai.com, then redeploy.`,
          ms: Date.now() - t0,
        };
      } catch (fallbackErr) {
        const fatal2 = classifyLlmError(fallbackErr);
        if (fatal2) return { status: "fail", message: `${fatal.message} Fallback ${FALLBACK_MODEL} also failed: ${fatal2.message}`, blocking: true, ms: Date.now() - t0 };
        return { status: "warn", message: `${PRIMARY_MODEL} unavailable and the ${FALLBACK_MODEL} ping failed (transient?): ${errorMessage(fallbackErr).slice(0, 160)}`, ms: Date.now() - t0 };
      }
    }
    const ms = Date.now() - t0;
    if (fatal) {
      return { status: "fail", message: fatal.message, blocking: true, ms };
    }
    const msg = errorMessage(err);
    if (/timeout|abort/i.test(msg)) {
      return { status: "warn", message: `OpenAI ping timed out after ${Math.round(timeoutMs / 1000)}s (slow, not necessarily down)`, ms };
    }
    return { status: "warn", message: `OpenAI ping failed (transient?): ${msg.slice(0, 200)}`, ms };
  }
}

/** ONE authenticated request, no retry ladder: a status light, not a fix attempt. */
export async function checkWordPress(timeoutMs = 12_000): Promise<HealthCheck> {
  if (!WP_API_BASE || !process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD) {
    return { status: "fail", message: "WP_URL / WP_USERNAME / WP_APP_PASSWORD not fully set" };
  }
  const auth = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString("base64");
  const t0 = Date.now();
  try {
    const res = await fetch(`${WP_API_BASE}/wp-json/wp/v2/posts?per_page=1&_fields=id&context=edit`, {
      headers: { Authorization: `Basic ${auth}`, ...WP_HEADERS, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (isSgCaptcha(text)) {
      return {
        status: "warn",
        message: `SiteGround anti-bot challenged this request${WP_API_VIA_RELAY ? " (even via the relay)" : ""}`,
        hint: "Intermittent from Vercel's shared IPs. Publishing retries automatically; see README → SiteGround for the permanent fix.",
        ms,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "fail", message: `WordPress rejected the credentials (HTTP ${res.status})`, hint: "Check WP_USERNAME and the application password.", ms };
    }
    if (!res.ok) {
      return { status: "warn", message: `WordPress returned HTTP ${res.status}`, ms };
    }
    try { JSON.parse(text); } catch {
      return { status: "warn", message: "WordPress returned a non-JSON response", ms };
    }
    if (WP_API_VIA_RELAY && !WP_RELAY_KEY) {
      return { status: "warn", message: "REST API reachable via relay, but WP_RELAY_KEY is not set", hint: "The relay only accepts requests carrying X-Relay-Key. Add WP_RELAY_KEY in Vercel (same value as RELAY_KEY on the relay) and redeploy.", ms };
    }
    return { status: "ok", message: `REST API reachable${WP_API_VIA_RELAY ? " via relay" : ""}`, ms };
  } catch (err) {
    return { status: "fail", message: `WordPress unreachable: ${errorMessage(err).slice(0, 160)}`, ms: Date.now() - t0 };
  }
}

export async function checkStorage(): Promise<HealthCheck> {
  const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  const t0 = Date.now();
  try {
    await kset("aston:health:ping", new Date().toISOString());
    await getSettings();
    if (!hasRedis) {
      const onVercel = !!process.env.VERCEL;
      return {
        status: onVercel ? "fail" : "warn",
        message: "No Upstash Redis configured — using local file storage",
        hint: onVercel ? "Queue state will not persist between invocations. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." : undefined,
        blocking: onVercel,
        ms: Date.now() - t0,
      };
    }
    return { status: "ok", message: "Upstash Redis reachable", ms: Date.now() - t0 };
  } catch (err) {
    return { status: "fail", message: `Storage error: ${errorMessage(err).slice(0, 160)}`, blocking: true, ms: Date.now() - t0 };
  }
}

export function checkAlerts(): HealthCheck {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { status: "ok", message: "Telegram alerts configured" };
  }
  if (process.env.NOTIFY_WEBHOOK_URL) {
    return { status: "ok", message: "Webhook alerts configured" };
  }
  return {
    status: "warn",
    message: "Not configured — failures are only visible in Vercel logs",
    hint: "Add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (or NOTIFY_WEBHOOK_URL for Slack/Discord) in Vercel → Settings → Environment Variables, then redeploy. Use “Send test alert” to confirm.",
  };
}

export async function checkBudget(): Promise<{ check: HealthCheck; usage: UsageTotals | null }> {
  try {
    const usage = await getMonthlyUsage();
    const budget = monthlyTokenBudget();
    const cost = usage.estimatedCostUsd != null ? ` · ≈ $${usage.estimatedCostUsd.toFixed(2)}` : "";
    const base = `${formatTokens(usage.totalTokens)} tokens · ${usage.calls} calls · ${usage.images} images this month${cost}`;
    if (budget == null) {
      return { check: { status: "ok", message: base, hint: "Set OPENAI_MONTHLY_TOKEN_BUDGET to pause generation past a monthly token limit, and OPENAI_PRICING to see cost estimates." }, usage };
    }
    const pct = Math.round((usage.totalTokens / budget) * 100);
    if (usage.totalTokens >= budget) {
      return {
        check: { status: "fail", message: `${base} — monthly OpenAI token budget reached (${pct}% of ${formatTokens(budget)})`, hint: "Raise OPENAI_MONTHLY_TOKEN_BUDGET or wait for the new month.", blocking: true },
        usage,
      };
    }
    return { check: { status: pct >= 80 ? "warn" : "ok", message: `${base} — ${pct}% of the ${formatTokens(budget)} budget` }, usage };
  } catch (err) {
    return { check: { status: "warn", message: `Usage totals unavailable: ${errorMessage(err).slice(0, 120)}` }, usage: null };
  }
}

export async function runHealthReport(opts: { skipOpenAI?: boolean; skipWordPress?: boolean; openaiTimeoutMs?: number } = {}): Promise<HealthReport> {
  const [openai, wordpress, storage, budgetRes] = await Promise.all([
    opts.skipOpenAI ? Promise.resolve<HealthCheck>({ status: "ok", message: "skipped" }) : checkOpenAI(opts.openaiTimeoutMs),
    opts.skipWordPress ? Promise.resolve<HealthCheck>({ status: "ok", message: "skipped" }) : checkWordPress(),
    checkStorage(),
    checkBudget(),
  ]);
  const alerts = checkAlerts();
  const checks: Array<[string, HealthCheck]> = [["OpenAI", openai], ["Storage", storage], ["Budget", budgetRes.check]];
  const blockers = checks.filter(([, c]) => c.blocking).map(([name, c]) => `${name}: ${c.message}`);
  return {
    checkedAt: new Date().toISOString(),
    canGenerate: blockers.length === 0,
    blockers,
    openai, wordpress, storage, alerts,
    budget: budgetRes.check,
    usage: budgetRes.usage,
    usageMonth: monthKey(),
    wpApiViaRelay: WP_API_VIA_RELAY,
  };
}

/**
 * Pre-flight for the cron dispatcher: everything that can block, plus the
 * WordPress light for the log line. Returns the blockers as one message.
 */
export async function preflight(): Promise<{ ok: boolean; message: string; report: HealthReport }> {
  // 20s OpenAI ping: the cron has a 60s budget and still has to start workflows.
  const report = await runHealthReport({ openaiTimeoutMs: 20_000 });
  const ok = report.canGenerate;
  const message = ok ? "" : report.blockers.join(" | ");
  console.log(
    `[preflight] openai=${report.openai.status} wordpress=${report.wordpress.status} storage=${report.storage.status} ` +
    `budget=${report.budget.status} alerts=${report.alerts.status}${ok ? "" : ` — BLOCKED: ${message}`}`
  );
  return { ok, message, report };
}
