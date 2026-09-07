import { describe, it, expect } from "vitest";
import { humaniseError, formatQueueError, isNonRetryableMessage, stripStepPrefix } from "@/lib/errors";

const NO_CREDITS =
  'Step "step//./lib/workflows/generatePost//strategyStep" failed after 3 retries: 429 You have no credits remaining. ' +
  "Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.";

describe("humaniseError", () => {
  it("turns the no-credits 429 into a billing action and names the step", () => {
    const h = humaniseError(NO_CREDITS);
    expect(h.kind).toBe("quota");
    expect(h.retryable).toBe(false);
    expect(h.step).toBe("strategy");
    expect(h.title).toContain("OpenAI credits exhausted");
    expect(h.title).toContain("strategy step");
    expect(formatQueueError(h)).toMatch(/Retry now/);
    expect(h.raw).toBe(NO_CREDITS);
  });

  it("classifies a SiteGround block as a retryable WordPress problem", () => {
    const h = humaniseError("WP post creation skipped — SiteGround anti-bot is persistently blocking this deployment's IP.");
    expect(h.kind).toBe("wordpress_blocked");
    expect(h.retryable).toBe(true);
  });

  it("classifies timeouts as retryable", () => {
    expect(humaniseError("content: The operation was aborted due to timeout").kind).toBe("timeout");
  });

  it("treats a rejected API key as non-retryable", () => {
    expect(isNonRetryableMessage("401 Incorrect API key provided: sk-proj-…")).toBe(true);
    expect(humaniseError("401 Incorrect API key provided").kind).toBe("auth");
  });

  it("treats the watchdog message as interrupted", () => {
    expect(humaniseError("Generation was interrupted (timed out or the function stopped). Auto-recovered by the watchdog.").kind).toBe("interrupted");
  });

  it("falls back to the first sentence for unknown errors", () => {
    const h = humaniseError("Something odd happened. Then more text.");
    expect(h.kind).toBe("unknown");
    expect(h.title).toBe("Something odd happened.");
    expect(h.retryable).toBe(true);
  });

  it("accepts Error instances", () => {
    expect(humaniseError(new Error("fetch failed")).kind).toBe("timeout");
  });
});

describe("stripStepPrefix", () => {
  it("removes WDK's step prefix and maps the step to a friendly name", () => {
    expect(stripStepPrefix('Step "step//./lib/workflows/generatePost//contentStep" failed after 3 retries: boom'))
      .toEqual({ message: "boom", step: "article writing" });
  });
  it("leaves other messages alone", () => {
    expect(stripStepPrefix("plain")).toEqual({ message: "plain" });
  });
});
