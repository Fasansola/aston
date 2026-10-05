import { describe, it, expect } from "vitest";
import { resolveFocusKeyword } from "@/lib/titleEngine";
import { TITLE_QA_CHECKS, withoutTitleChecks } from "@/lib/qaChecks";
import { RETRYABLE_WARNING_CHECKS } from "@/lib/qa";

describe("resolveFocusKeyword", () => {
  const title = "How to open a company in DIFC";

  it("keeps a model or strategy keyword only when it is in the title", () => {
    expect(resolveFocusKeyword(title, "company in DIFC")).toBe("company in DIFC");
    expect(resolveFocusKeyword(title, "DIFC company setup", "open a company")).toBe("open a company");
  });

  it("falls back to consecutive words of the title, so the keyword is always in it", () => {
    const kw = resolveFocusKeyword(title, "DIFC company setup", "Dubai company formation");
    expect(kw).toBe("open a company");
    expect(title.toLowerCase()).toContain(kw.toLowerCase());
  });

  it("handles punctuation, short titles and non-Latin titles", () => {
    for (const t of ["UAE trade licence: costs, timelines and banking", "VARA", "تأسيس شركة في دبي للمستثمرين", "The what and the why"]) {
      const kw = resolveFocusKeyword(t, "", "");
      expect(kw.length).toBeGreaterThan(0);
      expect(t.toLowerCase()).toContain(kw.toLowerCase());
    }
  });
});

describe("withoutTitleChecks", () => {
  it("marks the title checks as passed and leaves the rest alone", () => {
    const checks = { seo_title_length_ok: false, no_dashes_in_title: false, seo_title_focused: false, sentence_length_ok: false, cta_exists: true };
    const out = withoutTitleChecks(checks);
    expect(out).toEqual({ seo_title_length_ok: true, no_dashes_in_title: true, seo_title_focused: true, sentence_length_ok: false, cta_exists: true });
    expect(checks.seo_title_length_ok).toBe(false);
    expect(Object.keys(out)).not.toContain("focus_keyword_in_title");
  });

  it("leaves no title check able to trigger a retry", () => {
    const allFailing = Object.fromEntries([...RETRYABLE_WARNING_CHECKS, ...TITLE_QA_CHECKS].map((k) => [k, false]));
    const out = withoutTitleChecks(allFailing);
    const retryable = RETRYABLE_WARNING_CHECKS.filter((k) => out[k] === false);
    expect(retryable).not.toContain("seo_title_focused");
    expect(retryable).toContain("word_count_in_range");
  });
});
