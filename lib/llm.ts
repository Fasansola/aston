/**
 * lib/llm.ts
 * ─────────────────────────────────────────────────────────────
 * Shared OpenAI chat helper used by every generation step.
 *
 * Reliability layers (each fixes a class of failures seen in production):
 *  - response_format json_object → the API guarantees syntactically valid
 *    JSON, eliminating "No JSON found" / unescaped-quote parse failures
 *  - FAIL FAST on non-retryable errors: no credits (429 insufficient_quota),
 *    bad API key (401/403), unknown model (404), rejected request shape (400).
 *    These throw NonRetryableLlmError immediately with an operator-facing
 *    message. Before this, a billing 429 was retried like a rate limit —
 *    every run from 2026-08-26 to 09-07 made sixteen doomed calls before
 *    failing with a message that started with an internal step name.
 *  - rate-limit aware: a genuine 429/5xx waits out Retry-After before
 *    retrying, instead of failing the step and letting WDK re-hit the same
 *    limit 5s later
 *  - model fallback with a generous timeout when the primary attempt fails
 *  - reasoning models (gpt-5.x) get temperature/top_p stripped automatically,
 *    so a media call can be switched to gpt-5.5 by env without a 400
 *  - usage accounting: every successful call reports its token usage to the
 *    listener installed by lib/usage.ts (per run + per month), so cost is
 *    visible on the dashboard instead of only on the OpenAI invoice
 *  - extractJson(): fence-stripping, string-aware balanced-brace extraction
 *    for any response that still arrives with surrounding text
 */

import OpenAI from "openai";

export const PRIMARY_MODEL = "gpt-5.5";
// gpt-5.3 returns 404 on this account; gpt-5.5 is the only ≥5.3 model available,
// so the fallback retries the same model on transient errors (not a downgrade).
export const FALLBACK_MODEL = "gpt-5.5";
// Media pipeline copy (video/HeyGen scripts, YouTube SEO, podcast dialogue).
// gpt-4o by default for latency (those routes have tight budgets); switch the
// whole media line to a reasoning model with MEDIA_LLM_MODEL=gpt-5.5 — the
// helper strips temperature for gpt-5.x automatically.
export const MEDIA_MODEL = process.env.MEDIA_LLM_MODEL?.trim() || "gpt-4o";

/** gpt-5.x / o-series reject custom temperature and top_p. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/i.test(model.trim());
}

// ── Non-retryable error classification ───────────────────────

export type LlmFailureKind = "quota" | "auth" | "model" | "request" | "content";

/**
 * An OpenAI failure that no retry can fix. Carries an operator-facing message
 * (what happened + what to do). Workflow steps convert it to a FatalError so
 * WDK stops retrying; routes surface the message as-is.
 */
export class NonRetryableLlmError extends Error {
  readonly nonRetryable = true as const;
  readonly kind: LlmFailureKind;
  readonly original?: unknown;
  constructor(kind: LlmFailureKind, message: string, original?: unknown) {
    super(message);
    this.name = "NonRetryableLlmError";
    this.kind = kind;
    this.original = original;
  }
}

/** Duck-typed so it survives bundle boundaries (dynamic vs static imports). */
export function isNonRetryableLlmError(err: unknown): err is NonRetryableLlmError {
  return !!err && typeof err === "object" && (err as { nonRetryable?: unknown }).nonRetryable === true;
}

type ApiErrLike = {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  message?: unknown;
  error?: { code?: unknown; type?: unknown; message?: unknown } | null;
};

const QUOTA_RE = /no credits remaining|insufficient_quota|exceeded your current quota|billing hard limit|add credits to continue/i;

/**
 * Returns a NonRetryableLlmError when the error is deterministic (billing,
 * auth, model access, request shape, content policy); null for anything a
 * retry might fix (timeouts, 429 rate limits, 5xx, network).
 */
export function classifyLlmError(err: unknown): NonRetryableLlmError | null {
  if (isNonRetryableLlmError(err)) return err;
  if (!err || typeof err !== "object") return null;
  const e = err as ApiErrLike;
  const status  = typeof e.status === "number" ? e.status : undefined;
  const code    = String(e.code ?? e.error?.code ?? "").toLowerCase();
  const type    = String(e.type ?? e.error?.type ?? "").toLowerCase();
  const message = String(e.message ?? e.error?.message ?? "");

  if (code === "insufficient_quota" || type === "insufficient_quota" || QUOTA_RE.test(message)) {
    return new NonRetryableLlmError(
      "quota",
      "OpenAI account has no credits remaining. Add credits (and turn on auto-recharge) at platform.openai.com → Settings → Billing, then retry.",
      err
    );
  }
  if (status === 401 || code === "invalid_api_key") {
    return new NonRetryableLlmError(
      "auth",
      "OpenAI rejected the API key (401). Check OPENAI_API_KEY in Vercel → Settings → Environment Variables, then redeploy.",
      err
    );
  }
  if (status === 403) {
    return new NonRetryableLlmError("auth", `OpenAI refused the request (403): ${message}`, err);
  }
  if (status === 404) {
    return new NonRetryableLlmError("model", `OpenAI model not available on this account: ${message}`, err);
  }
  if (status === 400 || status === 422) {
    if (/content_policy|safety system|content management policy|moderation/i.test(message)) {
      return new NonRetryableLlmError("content", `OpenAI declined the content: ${message}`, err);
    }
    return new NonRetryableLlmError("request", `OpenAI rejected the request (${status}): ${message}`, err);
  }
  return null;
}

// ── Usage accounting ──────────────────────────────────────────

export interface LlmUsageRecord {
  kind: "chat" | "image";
  label: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  at: string;
}

type UsageListener = (rec: LlmUsageRecord) => void;
let usageListener: UsageListener | null = null;

/** Installed by lib/usage.ts (which owns the per-run AsyncLocalStorage context). */
export function setUsageListener(fn: UsageListener | null): void {
  usageListener = fn;
}

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;   // images API shape
  output_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

/** Log a call's token usage and hand it to the usage listener (if any). Never throws. */
export function recordUsage(args: { kind: "chat" | "image"; label: string; model: string; usage?: UsageLike | null }): void {
  const u = args.usage;
  const prompt     = u?.prompt_tokens ?? u?.input_tokens ?? 0;
  const completion = u?.completion_tokens ?? u?.output_tokens ?? 0;
  const reasoning  = u?.completion_tokens_details?.reasoning_tokens ?? 0;
  const total      = u?.total_tokens ?? prompt + completion;
  const rec: LlmUsageRecord = {
    kind: args.kind, label: args.label, model: args.model,
    promptTokens: prompt, completionTokens: completion, reasoningTokens: reasoning, totalTokens: total,
    at: new Date().toISOString(),
  };
  console.log(`[llm:usage] ${args.kind} ${args.label} ${args.model} prompt=${prompt} completion=${completion} reasoning=${reasoning}`);
  try { usageListener?.(rec); } catch (err) {
    console.warn(`[llm:usage] listener failed (non-fatal): ${errorMessage(err)}`);
  }
}

// ── Chat with retry ───────────────────────────────────────────

type ChatParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model" | "stream">;

export interface ChatRetryOpts {
  /** Step name used in log lines and error messages. */
  label: string;
  /** Per-attempt budget for the primary model. */
  timeoutMs: number;
  /** Budget for the fallback attempt (default 300s, or `timeoutMs` when a custom model is given). */
  fallbackTimeoutMs?: number;
  /** Ask the API to guarantee a valid JSON object (default true). */
  json?: boolean;
  /** Override the model (default PRIMARY_MODEL). Reasoning models get temperature/top_p stripped. */
  model?: string;
  /** Override the fallback model (default: same as `model` when given, else FALLBACK_MODEL). */
  fallbackModel?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * If the error is a rate limit (429) or server error (5xx), returns how long
 * to wait before retrying — honouring the Retry-After header when present,
 * clamped to [1s, 30s]. Returns null for every other kind of error.
 */
function retryAfterMs(err: unknown): number | null {
  const e = err as { status?: number; headers?: Record<string, string> | Headers } | null;
  if (!e || typeof e.status !== "number") return null;
  if (e.status !== 429 && e.status < 500) return null;
  let ra: string | null | undefined;
  if (e.headers instanceof Headers) ra = e.headers.get("retry-after");
  else if (e.headers) ra = e.headers["retry-after"] ?? e.headers["Retry-After"];
  const secs = ra ? parseFloat(ra) : NaN;
  const wait = Number.isFinite(secs) ? secs * 1000 : 10_000;
  return Math.min(Math.max(wait, 1_000), 30_000);
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errMsg = errorMessage;

/**
 * Chat completion with fail-fast classification, rate-limit-aware retry and
 * model fallback. Attempt order: primary → (wait out Retry-After, primary
 * again if 429/5xx) → fallback → (wait, fallback again if 429/5xx). At most 4
 * API calls — and ZERO extra calls once an error is known to be permanent.
 */
export async function chatWithRetry(
  openai: OpenAI,
  params: ChatParams,
  opts: ChatRetryOpts
): Promise<OpenAI.Chat.ChatCompletion> {
  const { label, timeoutMs, json = true } = opts;
  const primaryModel      = opts.model ?? PRIMARY_MODEL;
  const fallbackModel     = opts.fallbackModel ?? (opts.model ? opts.model : FALLBACK_MODEL);
  const fallbackTimeoutMs = opts.fallbackTimeoutMs ?? (opts.model ? timeoutMs : 300_000);

  const attempt = async (model: string, budget: number) => {
    const req: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      ...params,
      model,
      stream: false,
      ...(json ? { response_format: { type: "json_object" as const } } : {}),
    };
    if (isReasoningModel(model)) {
      delete req.temperature;
      delete req.top_p;
    }
    const res = await openai.chat.completions.create(req, { signal: AbortSignal.timeout(budget) });
    recordUsage({ kind: "chat", label, model, usage: res.usage });
    return res;
  };

  let lastErr: unknown;
  try {
    return await attempt(primaryModel, timeoutMs);
  } catch (primaryErr) {
    const fatal = classifyLlmError(primaryErr);
    if (fatal) {
      console.error(`[llm] ${label}: non-retryable ${fatal.kind} error — ${fatal.message}`);
      throw fatal;
    }
    lastErr = primaryErr;
    const wait = retryAfterMs(primaryErr);
    if (wait !== null) {
      console.warn(`[llm] ${label}: ${primaryModel} rate-limited/5xx (${errMsg(primaryErr)}) — waiting ${Math.round(wait / 1000)}s before retrying`);
      await sleep(wait);
      try {
        return await attempt(primaryModel, timeoutMs);
      } catch (retryErr) {
        const fatalRetry = classifyLlmError(retryErr);
        if (fatalRetry) throw fatalRetry;
        lastErr = retryErr;
      }
    }
  }

  console.warn(`[llm] ${label}: ${primaryModel} failed (${errMsg(lastErr)}) — retrying with ${fallbackModel} on a ${Math.round(fallbackTimeoutMs / 1000)}s budget`);
  try {
    return await attempt(fallbackModel, fallbackTimeoutMs);
  } catch (fallbackErr) {
    const fatal = classifyLlmError(fallbackErr);
    if (fatal) throw fatal;
    const wait = retryAfterMs(fallbackErr);
    if (wait === null) throw fallbackErr;
    console.warn(`[llm] ${label}: ${fallbackModel} rate-limited/5xx (${errMsg(fallbackErr)}) — waiting ${Math.round(wait / 1000)}s for final attempt`);
    await sleep(wait);
    return attempt(fallbackModel, fallbackTimeoutMs);
  }
}

/**
 * Returns the assistant text, throwing a descriptive error if the response
 * was truncated by the token limit. On reasoning models (gpt-5.x) reasoning
 * tokens count against max_completion_tokens, so a tight cap can produce an
 * EMPTY message with finish_reason "length" — surfacing that explicitly beats
 * a misleading "no JSON found" downstream.
 */
export function assertCompleted(response: OpenAI.Chat.ChatCompletion, label: string): string {
  const choice = response.choices[0];
  if (!choice) throw new Error(`${label}: model returned no choices`);
  if (choice.finish_reason === "length") {
    throw new Error(
      `${label}: response was cut off by the token limit (finish_reason=length). ` +
      `Reasoning tokens count against max_completion_tokens — raise or remove the cap.`
    );
  }
  return choice.message.content?.trim() ?? "";
}

/** String-aware balanced scan: extracts the first complete JSON object/array. */
function scanBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * Extract and parse the JSON payload from a model response. Tolerates code
 * fences and prose before/after the JSON. Throws with the start AND end of
 * the raw text so truncation points are visible in logs.
 */
export function extractJson<T>(raw: string, label: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidate = scanBalanced(cleaned);
  if (!candidate) {
    throw new Error(`${label}: no JSON found in model response. Raw: ${raw.slice(0, 300)}`);
  }
  try {
    return JSON.parse(candidate) as T;
  } catch (e) {
    const tail = raw.length > 400 ? ` … end: ${raw.slice(-200)}` : "";
    throw new Error(`${label}: model returned invalid JSON (${errMsg(e)}). Raw start: ${raw.slice(0, 200)}${tail}`);
  }
}
