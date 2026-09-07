import { describe, it, expect } from "vitest";
import { runQA } from "@/lib/qa";
import type { BlogContent, ImagePrompts } from "@/lib/wordpress";

const NO_IMAGES = { keypointOneImg: 0, keypointTwoImg: 0, postSplitImg: 0, featuredImg: 0 };
const prompts = {} as unknown as ImagePrompts;

describe("runQA", () => {
  it("fails empty content with blocking issues", () => {
    const report = runQA({} as unknown as BlogContent, prompts, NO_IMAGES, "Test title");
    expect(report.status).toBe("fail");
    expect(report.blocking_issues.length).toBeGreaterThan(0);
    expect(report.checks.focus_keyword_exists).toBe(false);
    expect(report.checks.main_content_exists).toBe(false);
  });

  it("flags a dash in the title and finds the focus keyword in it", () => {
    const content = { seo_title: "UAE bank account – a guide for founders", focus_keyword: "UAE bank account" } as unknown as BlogContent;
    const report = runQA(content, prompts, NO_IMAGES, "UAE bank account – a guide for founders");
    expect(report.checks.no_dashes_in_title).toBe(false);
    expect(report.checks.focus_keyword_in_title).toBe(true);
  });
});
