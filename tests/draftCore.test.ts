import { describe, it, expect } from "vitest";
import { draftKeyFor, inputSignature, assembleArticleHtml, DRAFT_STAGE_LABELS } from "@/lib/draftCore";

describe("draft keys and signatures", () => {
  it("keys queue items by id and manual runs by a stable hash of the request", () => {
    expect(draftKeyFor({ queueItemId: "q_123" })).toBe("item:q_123");
    const a = draftKeyFor({ mode: "topic_only", title: "ADGM crypto license" });
    const b = draftKeyFor({ mode: "topic_only", title: "ADGM crypto license" });
    const c = draftKeyFor({ mode: "topic_only", title: "DIFC crypto license" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("manual:")).toBe(true);
  });

  it("changes the signature when anything that shapes the article changes, but not on whitespace", () => {
    const base = { hasTopic: true, title: "UAE VAT rules", mode: "topic_only", language: "en" };
    expect(inputSignature(base)).toBe(inputSignature({ ...base, title: "  UAE VAT rules " }));
    expect(inputSignature(base)).not.toBe(inputSignature({ ...base, customInstruction: "Focus on free zones" }));
    expect(inputSignature(base)).not.toBe(inputSignature({ ...base, primary_country: "Cyprus" }));
    expect(inputSignature(base)).not.toBe(inputSignature({ ...base, hasTopic: false }));
  });

  it("has a label for every stage", () => {
    for (const stage of ["started", "planned", "written", "qa_passed", "qa_exhausted", "published", "completed"] as const) {
      expect(DRAFT_STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

describe("assembleArticleHtml", () => {
  it("joins the sections in page order, strips image slots and wraps plain-text fields", () => {
    const html = assembleArticleHtml({
      key_takeaways: "<ul><li>One</li></ul>",
      main_content: "<p>Intro</p>IMGSLOT_MAIN",
      keypoint_one: "Pull-out one",
      more_content_1: "<h3>First</h3>",
      quote_2: "Build the file first.",
      more_content_6: "<h3>Last</h3>",
    });
    const order = ["<ul><li>One</li></ul>", "<p>Intro</p>", "aston-keypoint\">Pull-out one", "<h3>First</h3>", "<blockquote class=\"aston-quote\">Build the file first.</blockquote>", "<h3>Last</h3>"];
    let last = -1;
    for (const needle of order) {
      const idx = html.indexOf(needle);
      expect(idx, needle).toBeGreaterThan(last);
      last = idx;
    }
    expect(html).not.toContain("IMGSLOT_");
  });
});
