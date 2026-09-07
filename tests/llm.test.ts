import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import {
  classifyLlmError, extractJson, isReasoningModel, NonRetryableLlmError, isNonRetryableLlmError,
  chatWithRetry, resetModelAvailability, isModelUnavailable, PRIMARY_MODEL, FALLBACK_MODEL,
} from "@/lib/llm";

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

// Fake client: the primary model 404s, every other model answers.
function fakeClient(unavailable: string) {
  const calls: string[] = [];
  const create = async (req: { model: string }) => {
    calls.push(req.model);
    if (req.model === unavailable) {
      throw Object.assign(new Error(`The model \`${req.model}\` does not exist or you do not have access to it.`), { status: 404 });
    }
    return { choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }], usage: undefined, model: req.model };
  };
  return { calls, client: { chat: { completions: { create } } } as unknown as OpenAI };
}

describe("chatWithRetry model fallback", () => {
  it("treats a gpt-6 model as a reasoning model (no temperature)", () => {
    expect(isReasoningModel("gpt-6-astra")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
  });

  it("falls back to FALLBACK_MODEL when the primary is not available, then skips the primary next time", async () => {
    resetModelAvailability();
    const { calls, client } = fakeClient("gpt-6-astra");
    const res = await chatWithRetry(client, { messages: [{ role: "user", content: "hi" }] }, {
      label: "t", timeoutMs: 1000, model: "gpt-6-astra", fallbackModel: "gpt-5.5",
    });
    expect(res.model).toBe("gpt-5.5");
    expect(calls).toEqual(["gpt-6-astra", "gpt-5.5"]);
    expect(isModelUnavailable("gpt-6-astra")).toBe(true);

    await chatWithRetry(client, { messages: [{ role: "user", content: "again" }] }, {
      label: "t", timeoutMs: 1000, model: "gpt-6-astra", fallbackModel: "gpt-5.5",
    });
    expect(calls).toEqual(["gpt-6-astra", "gpt-5.5", "gpt-5.5"]);
    resetModelAvailability();
  });

  it("still fails fast on a 404 when there is no different fallback", async () => {
    resetModelAvailability();
    const { client } = fakeClient("gpt-5.5");
    await expect(chatWithRetry(client, { messages: [{ role: "user", content: "hi" }] }, {
      label: "t", timeoutMs: 1000, model: "gpt-5.5", fallbackModel: "gpt-5.5",
    })).rejects.toMatchObject({ kind: "model" });
  });

  it("defaults to gpt-6-astra with gpt-5.5 as the proven fallback", () => {
    expect(PRIMARY_MODEL).toBe(process.env.OPENAI_MODEL?.trim() || "gpt-6-astra");
    expect(FALLBACK_MODEL).toBe(process.env.OPENAI_FALLBACK_MODEL?.trim() || "gpt-5.5");
  });
});
