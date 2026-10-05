import { describe, it, expect } from "vitest";
import { FEATURED_EXAMPLES, assessFeaturedPrompt, featuredStyleBlock } from "@/lib/featuredImageStyle";
import { assessPromptDiversity } from "@/lib/imageBrief";

describe("featured image signature style", () => {
  it("every worked example passes its own check", () => {
    for (const e of FEATURED_EXAMPLES) expect(assessFeaturedPrompt(e.prompt), e.article).toEqual([]);
  });

  it("flags a brief that drops the formula", () => {
    const issues = assessFeaturedPrompt("A courier hands a sealed envelope across a registry counter in Abu Dhabi, documentary style, no readable text anywhere in the frame, photorealistic editorial photograph");
    expect(issues.join(" ")).toMatch(/skyline/);
    expect(issues.join(" ")).toMatch(/quotation marks/);
  });

  it("is offered to the model with the examples", () => {
    const block = featuredStyleBlock();
    expect(block).toMatch(/SIGNATURE STYLE/);
    expect(block).toContain(FEATURED_EXAMPLES[0].article);
  });

  it("would still be refused for an in-article slot by the diversity check", () => {
    const report = assessPromptDiversity([FEATURED_EXAMPLES[1].prompt, "A registry hall counter in Abu Dhabi", "A cargo yard at Jebel Ali at dawn"], ["Keypoint 1", "Split", "Keypoint 2"], { maxOffices: 1 });
    expect(report.ok).toBe(false);
  });
});
