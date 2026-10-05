import { describe, it, expect } from "vitest";
import {
  articleWordCount, countWords, wordCountPlan, isWordCountInRange,
  ARTICLE_MIN_WORDS, ARTICLE_MAX_WORDS, ARTICLE_TARGET_WORDS, INTRO_WORDS, SECTION_WORD_TARGETS,
} from "@/lib/wordBudget";
import { runQA, RETRYABLE_WARNING_CHECKS } from "@/lib/qa";
import type { BlogContent, ImagePrompts } from "@/lib/wordpress";

const words = (n: number) => `<p>${Array.from({ length: n }, () => "word").join(" ")}</p>`;

describe("article length rule", () => {
  it("is 2,000 to 2,400 words, inclusive", () => {
    expect(isWordCountInRange(ARTICLE_MIN_WORDS - 1)).toBe(false);
    expect(isWordCountInRange(ARTICLE_MIN_WORDS)).toBe(true);
    expect(isWordCountInRange(ARTICLE_MAX_WORDS)).toBe(true);
    expect(isWordCountInRange(ARTICLE_MAX_WORDS + 1)).toBe(false);
  });

  it("plans sections that add up to the target", () => {
    const fixed = 60 + 30 + 30 + 18 + 18 + 180 + 45 + 60; // takeaways, keypoints, quotes, FAQ, final points, flowchart
    const sections = Object.values(SECTION_WORD_TARGETS).reduce((a, b) => a + b, 0);
    const intro = (INTRO_WORDS.min + INTRO_WORDS.max) / 2;
    expect(Math.abs(fixed + sections + intro - ARTICLE_TARGET_WORDS)).toBeLessThan(100);
  });

  it("counts what the reader sees, not the excerpt, markup or placeholders", () => {
    expect(countWords("<h3>Two words</h3>\n[FLOWCHART_IMG]\n<p>three more&nbsp;words</p>")).toBe(5);
    const n = articleWordCount({
      main_content: words(300), more_content_5: words(100), excerpt: words(50),
      flowchart_steps: [{ title: "Submit file", detail: "The regulator reviews it" }],
    } as Partial<BlogContent>);
    expect(n).toBe(300 + 100 + 6);
  });
});

describe("wordCountPlan", () => {
  const article = (sectionWords: number) => ({
    main_content: words(320), more_content_1: words(sectionWords), more_content_2: words(sectionWords),
    more_content_3: words(sectionWords), more_content_4: words(sectionWords), more_content_6: words(sectionWords),
    key_takeaways: words(60), more_content_5: words(180), final_points: words(45),
  });

  it("is null when the article is in range", () => {
    expect(wordCountPlan(article(300))).toBeNull();
  });

  it("trims the body sections of a 3,800-word article towards 2,200", () => {
    const plan = wordCountPlan(article(640))!;
    expect(plan.total).toBe(320 + 5 * 640 + 285);
    expect(plan.direction).toBe("trim");
    const after = plan.total - plan.fields.reduce((n, f) => n + (f.current - f.target), 0);
    expect(isWordCountInRange(after)).toBe(true);
    expect(plan.fields.find((f) => f.field === "main_content")?.target ?? 320).toBeGreaterThanOrEqual(INTRO_WORDS.min);
  });

  it("expands a short article", () => {
    const plan = wordCountPlan(article(150))!;
    expect(plan.direction).toBe("expand");
    expect(plan.fields.every((f) => f.target > f.current)).toBe(true);
  });
});

describe("QA length check", () => {
  it("fails outside the range and is retryable", () => {
    const report = runQA({ main_content: words(3000) } as unknown as BlogContent, {} as unknown as ImagePrompts,
      { keypointOneImg: 0, keypointTwoImg: 0, postSplitImg: 0, featuredImg: 0 }, "T");
    expect(report.checks.word_count_in_range).toBe(false);
    expect(report.wordCount).toBe(3000);
    expect(RETRYABLE_WARNING_CHECKS).toContain("word_count_in_range");
  });
});
