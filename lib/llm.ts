/**
 * lib/llm.ts
 * ─────────────────────────────────────────────────────────────
 * Shared OpenAI chat helper used by every JSON-returning generation step.
 *
 * Reliability layers (each fixes a class of failures seen in production):
 *  - response_format json_object → the API guarantees syntactically valid
 *    JSON, eliminating "No JSON found" / unescaped-quote parse failures
 *  - rate-limit aware: a 429/5xx waits out Retry-After before retrying,
 *    instead of failing the step and letting WDK re-hit the same limit 5s later
 *  - model fallback with a generous timeout when the primary attempt fails
 *  - extractJson(): fence-stripping, string-aware balanced-brace extraction
 *    for any response that still arrives with surrounding text
 */

import OpenAI from "openai";

export const PRIMARY_MODEL = "gpt-5.5";
// gpt-5.3 returns 404 on this account; gpt-5.5 is the only ≥5.3 model available,
// so the fallback retries the same model on transient errors (not a downgrade).
export const FALLBACK_MODEL = "gpt-5.5";

type ChatParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, "model" | "stream">;

export interface ChatRetryOpts {
  /** Step name used in log lines and error messages. */
  label: string;
  /** Per-attempt budget for the primary model. */
  timeoutMs: number;
  /** Budget for the fallback attempt (default 300s). */
  fallbackTimeoutMs?: number;
  /** Ask the API to guarantee a valid JSON object (default true). */
  json?: boolean;
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

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Chat completion with rate-limit-aware retry and model fallback.
 * Attempt order: primary → (wait out Retry-After, primary again if 429/5xx)
 * → fallback → (wait, fallback again if 429/5xx). At most 4 API calls.
 */
export async function chatWithRetry(
  openai: OpenAI,
  params: ChatParams,
  opts: ChatRetryOpts
): Promise<OpenAI.Chat.ChatCompletion> {
  const { label, timeoutMs, fallbackTimeoutMs = 300_000, json = true } = opts;
  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    ...params,
    model: PRIMARY_MODEL,
    stream: false,
    ...(json ? { response_format: { type: "json_object" as const } } : {}),
  };

  const attempt = (model: string, budget: number) =>
    openai.chat.completions.create({ ...body, model }, { signal: AbortSignal.timeout(budget) });

  let lastErr: unknown;
  try {
    return await attempt(PRIMARY_MODEL, timeoutMs);
  } catch (primaryErr) {
    lastErr = primaryErr;
    const wait = retryAfterMs(primaryErr);
    if (wait !== null) {
      console.warn(`[llm] ${label}: ${PRIMARY_MODEL} rate-limited/5xx (${errMsg(primaryErr)}) — waiting ${Math.round(wait / 1000)}s before retrying`);
      await sleep(wait);
      try {
        return await attempt(PRIMARY_MODEL, timeoutMs);
      } catch (retryErr) {
        lastErr = retryErr;
      }
    }
  }

  console.warn(`[llm] ${label}: ${PRIMARY_MODEL} failed (${errMsg(lastErr)}) — retrying with ${FALLBACK_MODEL} on a ${Math.round(fallbackTimeoutMs / 1000)}s budget`);
  try {
    return await attempt(FALLBACK_MODEL, fallbackTimeoutMs);
  } catch (fallbackErr) {
    const wait = retryAfterMs(fallbackErr);
    if (wait === null) throw fallbackErr;
    console.warn(`[llm] ${label}: ${FALLBACK_MODEL} rate-limited/5xx (${errMsg(fallbackErr)}) — waiting ${Math.round(wait / 1000)}s for final attempt`);
    await sleep(wait);
    return attempt(FALLBACK_MODEL, fallbackTimeoutMs);
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
