import { describe, it, expect } from "vitest";
import { classifyLlmError, extractJson, isReasoningModel, NonRetryableLlmError, isNonRetryableLlmError } from "@/lib/llm";

describe("classifyLlmError", () => {
  it("flags the no-credits 429 as a permanent quota failure", () => {
    const err = classifyLlmError({ status: 429, message: "429 You have no credits remaining. Add credits to continue using the API." });
    expect(err?.kind).toBe("quota");
    expect(err?.message).toMatch(/Billing/);
  });

  it("flags insufficient_quota by error code even without the message", () => {
    expect(classifyLlmError({ status: 429, code: "insufficient_quota", message: "quota" })?.kind).toBe("quota");
  });

  it("leaves a genuine rate limit retryable", () => {
    expect(classifyLlmError({ status: 429, message: "Rate limit reached for gpt-5.5 in organization org-x" })).toBeNull();
  });

  it("classifies auth, model and request-shape errors as permanent", () => {
    expect(classifyLlmError({ status: 401, message: "Incorrect API key provided" })?.kind).toBe("auth");
    expect(classifyLlmError({ status: 404, message: "The model gpt-5.3 does not exist or you do not have access to it." })?.kind).toBe("model");
    expect(classifyLlmError({ status: 400, message: "Unsupported value: 'temperature' does not support 0.7 with this model." })?.kind).toBe("request");
  });

  it("leaves server errors and timeouts retryable", () => {
    expect(classifyLlmError({ status: 503, message: "Service unavailable" })).toBeNull();
    expect(classifyLlmError(new Error("The operation was aborted due to timeout"))).toBeNull();
    expect(classifyLlmError(null)).toBeNull();
  });

  it("passes an existing NonRetryableLlmError through", () => {
    const original = new NonRetryableLlmError("auth", "nope");
    expect(classifyLlmError(original)).toBe(original);
    expect(isNonRetryableLlmError(original)).toBe(true);
    expect(isNonRetryableLlmError(new Error("x"))).toBe(false);
  });
});

describe("isReasoningModel", () => {
  it("strips temperature only for gpt-5.x and o-series", () => {
    expect(isReasoningModel("gpt-5.5")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("gpt-4o-search-preview")).toBe(false);
  });
});

describe("extractJson", () => {
  it("tolerates fences and surrounding prose", () => {
    expect(extractJson<{ a: number }>('Sure:\n```json\n{"a": 1}\n```\nDone.', "t")).toEqual({ a: 1 });
  });
  it("ignores braces inside strings", () => {
    expect(extractJson<{ s: string }>('{"s": "a } b"} trailing', "t")).toEqual({ s: "a } b" });
  });
  it("throws a descriptive error when nothing parses", () => {
    expect(() => extractJson("no json here", "strategy")).toThrow(/strategy: no JSON found/);
    expect(() => extractJson('{"a": ', "strategy")).toThrow(/strategy: no JSON found|invalid JSON/);
  });
});
