/**
 * lib/errors.ts
 * ─────────────────────────────────────────────────────────────
 * Turns raw pipeline errors into something an operator can act on.
 *
 * Before this, a queue item's lastError read:
 *   Step "step//./lib/workflows/generatePost//strategyStep" failed after 3
 *   retries: 429 You have no credits remaining. Add credits to continue…
 * …and the dashboard truncated it after the step name, so the only part that
 * mattered ("no credits") was never visible. humaniseError() strips the step
 * prefix, classifies the failure, and returns a short title plus the exact
 * next action. The raw text is kept separately for the details view.
 *
 * Pure functions — no imports — so both workflow bodies and routes can use it.
 */

export type ErrorKind =
  | "quota" | "auth" | "model" | "request" | "budget"
  | "wordpress_blocked" | "wordpress"
  | "timeout" | "interrupted" | "malformed" | "workflow" | "unknown";

export interface HumanError {
  kind: ErrorKind;
  /** Short, plain-English statement of what went wrong. */
  title: string;
  /** The single next thing the operator should do. */
  action: string;
  /** Friendly name of the pipeline step that failed, when known. */
  step?: string;
  /** The original message, untouched. */
  raw: string;
  /** False when no retry can fix it (billing, auth, model, request shape). */
  retryable: boolean;
}

const STEP_NAMES: Record<string, string> = {
  deriveTitleStep: "title", researchStep: "research", selectLinksStep: "link selection",
  sourceBriefStep: "source brief", strategyStep: "strategy", blueprintStep: "blueprint",
  authorityLinksStep: "authority links", contentStep: "article writing", fixStep: "QA fix pass",
  scrubStep: "link checking", imagePromptsStep: "image prompts", qaStep: "quality checks",
  publishStep: "WordPress publish", recordHistoryStep: "history", completeItemStep: "bookkeeping",
  failItemStep: "bookkeeping", startMediaStep: "media start",
  imagesStep: "article images", audioStep: "audio", podcastStep: "podcast",
  videoSegmentStep: "video script", videoImageStep: "video images", videoAudioStep: "video narration",
  videoSubmitRenderStep: "video render", checkRenderStep: "video render", uploadVideoStep: "YouTube upload",
  triggerGenerationStep: "scheduling",
};

const STEP_PREFIX_RE = /^Step "step\/\/[^"]*\/\/([A-Za-z0-9_]+)" failed after \d+ retries:\s*/;

/** Removes WDK's `Step "…" failed after N retries:` prefix and names the step. */
export function stripStepPrefix(raw: string): { message: string; step?: string } {
  const m = raw.match(STEP_PREFIX_RE);
  if (!m) return { message: raw };
  const step = STEP_NAMES[m[1]] ?? m[1].replace(/Step$/, "");
  return { message: raw.slice(m[0].length), step };
}

export function humaniseError(input: unknown): HumanError {
  const raw = (input instanceof Error ? input.message : typeof input === "string" ? input : String(input ?? "")).trim();
  const { message, step } = stripStepPrefix(raw);
  const where = step ? ` (in the ${step} step)` : "";
  const build = (kind: ErrorKind, title: string, action: string, retryable: boolean): HumanError =>
    ({ kind, title: `${title}${where}`, action, step, raw, retryable });

  if (/no credits remaining|insufficient_quota|exceeded your current quota|has no credits/i.test(message)) {
    return build("quota", "OpenAI credits exhausted",
      "Top up at platform.openai.com → Settings → Billing (and turn on auto-recharge), then press Retry now.", false);
  }
  if (/monthly (openai )?token budget/i.test(message)) {
    return build("budget", "Monthly OpenAI token budget reached",
      "Raise OPENAI_MONTHLY_TOKEN_BUDGET in Vercel or wait for the new month, then press Retry now.", false);
  }
  if (/\b401\b|invalid_api_key|rejected the api key/i.test(message)) {
    return build("auth", "OpenAI API key rejected",
      "Check OPENAI_API_KEY in Vercel → Settings → Environment Variables, redeploy, then press Retry now.", false);
  }
  if (/model not available|does not exist or you do not have access|\b404\b[^]*model/i.test(message)) {
    return build("model", "OpenAI model not available on this account",
      "Check the model name in lib/llm.ts, or enable the model for this OpenAI organisation.", false);
  }
  if (/unsupported (value|parameter)|rejected the request \(4\d\d\)|context length|maximum context|invalid_request_error|declined the content/i.test(message)) {
    return build("request", "OpenAI rejected the request",
      "This is a code or prompt-size problem, not a transient one. Send the details below to the developer.", false);
  }
  if (/sgcaptcha|siteground|persistently blocking/i.test(message)) {
    return build("wordpress_blocked", "WordPress blocked the connection (SiteGround anti-bot)",
      "This usually clears within minutes: press Retry now. If it keeps happening, follow the SiteGround section in the README.", true);
  }
  if (/wordpress|wp-json|wp post creation|image upload|media upload|publishwordpresspost/i.test(message)) {
    return build("wordpress", "WordPress request failed",
      "Check that the site is up and the WP credentials are valid, then press Retry now.", true);
  }
  if (/interrupted|watchdog/i.test(message)) {
    return build("interrupted", "Generation was interrupted", "Press Retry now.", true);
  }
  if (/timed out|timeout|aborterror|timeouterror|aborted|socket hang up|econnreset|fetch failed/i.test(message)) {
    return build("timeout", "A step timed out or lost its connection", "Usually transient: press Retry now.", true);
  }
  if (/no json found|invalid json|finish_reason=length|cut off by the token limit|malformed/i.test(message)) {
    return build("malformed", "The model returned malformed or truncated output", "Usually transient: press Retry now.", true);
  }
  if (/could not start generation workflow|workflow failed to start|failed to start/i.test(message)) {
    return build("workflow", "Could not start the generation workflow",
      "Press Retry now. If it persists, check the Workflow status in the Vercel dashboard.", true);
  }
  const firstSentence = message.split(/(?<=[.!?])\s/)[0]?.slice(0, 160) || "Generation failed";
  return build("unknown", firstSentence,
    "Press Retry now. If it fails the same way twice, send the details below to the developer.", true);
}

/** One-line form for the queue item / notification: "<title>. <action>". */
export function formatQueueError(h: HumanError): string {
  return `${h.title}. ${h.action}`;
}

/** True when the message describes a failure no retry can fix. */
export function isNonRetryableMessage(input: unknown): boolean {
  return !humaniseError(input).retryable;
}
