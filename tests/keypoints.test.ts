import { describe, it, expect } from "vitest";
import { shortenKeypoint, KEYPOINT_MAX_CHARS, runQA, RETRYABLE_WARNING_CHECKS } from "@/lib/qa";
import type { BlogContent, ImagePrompts } from "@/lib/wordpress";

const NO_IMAGES = { keypointOneImg: 0, keypointTwoImg: 0, postSplitImg: 0, featuredImg: 0 };
const prompts = {} as unknown as ImagePrompts;

// Real overlong keypoints taken from posts 71279 and 71265 (2026-09-11).
const REAL_LONG = "A credible Dubai crypto budget starts with equivalent activities and permissions, rather than a headline licence fee. The regulator you choose changes the capital you must hold, the people you must hire and the systems you must buy before launch.";

describe("shortenKeypoint", () => {
  it("leaves text within the limit untouched", () => {
    const short = "An ADGM company is only the legal vehicle, not the permission to operate.";
    expect(shortenKeypoint(short)).toBe(short);
  });

  it("keeps whole sentences and never exceeds the limit", () => {
    const out = shortenKeypoint(REAL_LONG);
    expect(REAL_LONG.length).toBeGreaterThan(KEYPOINT_MAX_CHARS);
    expect(out.length).toBeLessThanOrEqual(KEYPOINT_MAX_CHARS);
    expect(out.endsWith(".")).toBe(true);
    expect(out).toBe("A credible Dubai crypto budget starts with equivalent activities and permissions, rather than a headline licence fee.");
  });

  it("falls back to a word-boundary cut when even the first sentence is too long", () => {
    const oneLongSentence = "The regulator you choose changes the capital you must hold and the people you must hire and the systems you must buy and the reporting you must file before you are allowed to launch at all";
    const out = shortenKeypoint(oneLongSentence);
    expect(out.length).toBeLessThanOrEqual(KEYPOINT_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
  });

  it("strips markup and collapses whitespace", () => {
    expect(shortenKeypoint("  <p>Tokenisation   is not\nmerely technology.</p> ")).toBe("Tokenisation is not merely technology.");
  });

  it("handles empty input", () => {
    expect(shortenKeypoint("")).toBe("");
    expect(shortenKeypoint(null)).toBe("");
    expect(shortenKeypoint(undefined)).toBe("");
  });
});

describe("keypoints_within_length QA check", () => {
  const base = { keypoint_one: "Short and within the limit.", keypoint_two: "Also short." } as unknown as BlogContent;

  it("passes when both keypoints fit", () => {
    expect(runQA(base, prompts, NO_IMAGES, "t").checks.keypoints_within_length).toBe(true);
  });

  it("fails when either keypoint is over the limit", () => {
    const over = { ...base, keypoint_two: REAL_LONG } as unknown as BlogContent;
    expect(runQA(over, prompts, NO_IMAGES, "t").checks.keypoints_within_length).toBe(false);
  });

  it("is retryable, so a breach triggers a targeted fix pass rather than failing the post", () => {
    expect([...RETRYABLE_WARNING_CHECKS]).toContain("keypoints_within_length");
  });
});
