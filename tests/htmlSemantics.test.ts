import { describe, it, expect } from "vitest";
import { normaliseArticleHtml, findHeadingIssues, stripFaqHeading, FAQ_HEADING } from "@/lib/htmlSemantics";
import { runQA } from "@/lib/qa";
import type { BlogContent, ImagePrompts } from "@/lib/wordpress";

describe("normaliseArticleHtml", () => {
  it("removes the focus-keyword H1 the model put in key takeaways (post 71641)", () => {
    const { content, changes } = normaliseArticleHtml({
      key_takeaways: "<h1>EMI acquisition due diligence</h1>\n<ul>\n<li>Tests inherited liabilities.</li>\n</ul>",
    });
    expect(content.key_takeaways).toBe("<ul>\n<li>Tests inherited liabilities.</li>\n</ul>");
    expect(changes).toEqual(["key_takeaways"]);
  });

  it("turns a heading inside the definition block into the term (post 71505)", () => {
    const { content } = normaliseArticleHtml({
      main_content: `<p>Intro.</p><div class="aston-definition">\n<h4>Approval to Incorporate</h4>\n<p class="aston-definition__text">ATI lets you incorporate.</p>\n</div><h3>Next</h3>`,
    });
    expect(content.main_content).toContain('<strong class="aston-definition__term">Approval to Incorporate</strong>');
    expect(content.main_content).not.toContain("<h4>");
  });

  it("makes chart and infographic titles captions, not headings", () => {
    const { content } = normaliseArticleHtml({
      more_content_2: `<h3>Safeguarding</h3><div class="aston-visual-block aston-infographic"><h4 class="aston-visual-block__title">Five tests</h4><ul><li>a</li></ul></div><div class="aston-chart-block"><h4 class="aston-chart-block__title">PSD2 capital</h4></div>`,
    });
    expect(content.more_content_2).toContain('<p class="aston-visual-block__title">Five tests</p>');
    expect(content.more_content_2).toContain('<p class="aston-chart-block__title">PSD2 capital</p>');
  });

  it("demotes H1/H2 to H3 and promotes an H4 that comes before any H3", () => {
    const { content } = normaliseArticleHtml({
      more_content_1: "<h2>Section</h2><h4>Sub</h4>",
      more_content_3: "<h4>Orphan</h4><p>x</p><h3>Section</h3><h4>Sub</h4>",
    });
    expect(content.more_content_1).toBe("<h3>Section</h3><h4>Sub</h4>");
    expect(content.more_content_3).toBe("<h3>Orphan</h3><p>x</p><h3>Section</h3><h4>Sub</h4>");
  });

  it("nests FAQ questions as H4s under one FAQ H3, idempotently", () => {
    const once = normaliseArticleHtml({
      more_content_5: "<h3>Can banks terminate?</h3><p>Yes.</p><h3>Is capital included?</h3><p>No.</p>",
    }).content;
    expect(once.more_content_5).toBe(`<h3>${FAQ_HEADING}</h3>\n<h4>Can banks terminate?</h4><p>Yes.</p><h4>Is capital included?</h4><p>No.</p>`);
    const twice = normaliseArticleHtml(once);
    expect(twice.content.more_content_5).toBe(once.more_content_5);
    expect(twice.changes).toEqual([]);
  });

  it("leaves a sound article untouched", () => {
    const sound = {
      main_content: "<p>Intro.</p><h3>Why</h3><p>x</p><h4>Detail</h4><p>y</p>",
      more_content_1: "<h3>Section</h3><h4>Sub</h4><p>z</p>",
      key_takeaways: "<ul><li>One.</li></ul>",
    };
    expect(normaliseArticleHtml(sound).changes).toEqual([]);
  });
});

describe("findHeadingIssues", () => {
  it("reports what the repair is meant to remove", () => {
    const issues = findHeadingIssues({
      key_takeaways: "<h1>Keyword</h1><ul><li>a</li></ul>",
      more_content_1: "<h4>Orphan</h4><h3>Section</h3>",
      more_content_2: '<h3>S</h3><h4 class="aston-chart-block__title">Chart</h4>',
      more_content_5: "<h3>Question?</h3><p>a</p>",
    });
    expect(issues.join(" | ")).toMatch(/key_takeaways contains a heading/);
    expect(issues.join(" | ")).toMatch(/more_content_1 has an H4 before any H3/);
    expect(issues.join(" | ")).toMatch(/more_content_2 uses a heading for a chart/);
    expect(issues.join(" | ")).toMatch(/more_content_5 questions must be H4s/);
  });

  it("finds nothing once the content is normalised", () => {
    const { content } = normaliseArticleHtml({
      key_takeaways: "<h1>Keyword</h1><ul><li>a</li></ul>",
      main_content: '<p>i</p><div class="aston-definition"><h4>Term</h4><p class="aston-definition__text">d</p></div>',
      more_content_2: '<h3>S</h3><h4 class="aston-chart-block__title">Chart</h4>',
      more_content_5: "<h3>Question?</h3><p>a</p>",
    });
    expect(findHeadingIssues(content)).toEqual([]);
  });

  it("is a QA warning that triggers the targeted fix pass", () => {
    const report = runQA({ key_takeaways: "<h1>Keyword</h1><ul><li>a</li></ul>" } as unknown as BlogContent,
      {} as unknown as ImagePrompts, { keypointOneImg: 0, keypointTwoImg: 0, postSplitImg: 0, featuredImg: 0 }, "T");
    expect(report.checks.heading_structure_ok).toBe(false);
  });
});

describe("stripFaqHeading", () => {
  it("drops only the block heading, for narration", () => {
    expect(stripFaqHeading(`<h3>${FAQ_HEADING}</h3>\n<h4>Q?</h4><p>A.</p>`)).toBe("\n<h4>Q?</h4><p>A.</p>");
  });
});
