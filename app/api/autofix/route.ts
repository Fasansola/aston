/**
 * app/api/autofix/route.ts
 * POST /api/autofix
 *
 * Two-pass fix pipeline:
 *  Pass 1 — GPT comprehensively rewrites the HTML to fix all readiness issues
 *            AND proactively improves readability, structure, transitions,
 *            sentence length, passive voice, keyword density, and subheadings.
 *  Pass 2 — Mechanical cleanup (US spellings, heading case, bold in paragraphs,
 *            decorative symbols) runs on GPT's output as a final safety net.
 */

import { NextRequest, NextResponse } from "next/server";
import { applyAutoFixes } from "@/lib/readinessValidator";
import OpenAI from "openai";

export const maxDuration = 120;

const SYSTEM_PROMPT = `You are a senior SEO copyeditor and content strategist for Aston VIP (Aston.ae) — a full-service international corporate advisory firm based in London and Dubai. Aston VIP advises entrepreneurs, investors, family offices, and fintech businesses on company formation, regulatory licensing, corporate banking, and cross-border tax structuring across 20+ jurisdictions including the UAE (mainland, DIFC, ADGM, free zones), UK, Cyprus, Switzerland, Hong Kong, and others.

Your job is to deeply improve blog article HTML so it scores well on SEO readiness, Yoast readability, and Aston VIP editorial standards — not just fix surface issues.

EDITORIAL RULES YOU MUST ENFORCE:
- British English throughout: organisation, licence (noun), authorise, centre, optimise, travelling, recognise
- Sentence case for all headings — capitalise only the first word and proper nouns (DIFC, ADGM, UAE, VARA, UK, Aston VIP, etc.)
- No bold inside <p> tags — bold is for headings only
- No em dashes or en dashes — use commas or restructure
- No decorative symbols (→, ★, ✓, etc.)
- Active voice: rewrite passive constructions (e.g. "the licence is issued by the regulator" → "the regulator issues the licence")
- Transition words: at least one transition per three sentences (however, therefore, because, as a result, for example, in addition, in practice, by contrast, more importantly, in most cases)
- Sentence length: aim for 15–20 words per sentence. Never exceed 25 words in a single sentence — split long sentences into two
- Paragraph length: maximum 4 sentences per paragraph
- Subheading distribution: sections longer than 200 words must include at least one H3 subheading to break up the text. Add subheadings where they are missing
- Preserve ALL links (<a href="...">...</a>) including href, target, and rel attributes`;

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { html, language, issues, focusKeyword, title, seoTitle } = await req.json();

    if (!html?.trim()) {
      return NextResponse.json({ error: "html is required" }, { status: 400 });
    }

    // ── Pass 1: AI comprehensive rewrite ─────────────────────────
    let rewrittenHtml = html;
    const aiFixSummary: string[] = [];

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const flaggedIssues = Array.isArray(issues)
      ? issues.filter((i: { severity: string }) => i.severity !== "passed")
      : [];

    const issueList = flaggedIssues.length > 0
      ? flaggedIssues
          .map((i: { message: string; suggestedFix?: string }) =>
            i.suggestedFix ? `• ${i.message} → Fix: ${i.suggestedFix}` : `• ${i.message}`
          )
          .join("\n")
      : "No specific issues flagged — perform a full quality pass.";

    const contextBlock = [
      focusKeyword ? `Focus keyword: ${focusKeyword}` : "",
      title        ? `Article title: ${title}` : "",
      seoTitle     ? `SEO title: ${seoTitle}` : "",
    ].filter(Boolean).join("\n");

    const prompt = `${contextBlock ? `ARTICLE CONTEXT:\n${contextBlock}\n\n` : ""}FLAGGED ISSUES TO FIX:
${issueList}

YOUR TASK:
Fix every flagged issue above AND perform a comprehensive quality pass on the entire article. Do not limit yourself to only the flagged issues — proactively improve the article wherever the editorial rules are not being met.

WHAT YOU MUST DO:
1. Fix every flagged issue listed above — do not skip any
2. Add H3 subheadings to any section longer than 200 words that does not already have one — Yoast requires good subheading distribution
3. Shorten any sentence over 25 words by splitting it into two shorter sentences
4. Rewrite passive voice constructions to active voice throughout
5. Add transition words where three or more consecutive sentences lack one
6. Ensure the focus keyword appears naturally in the first paragraph if not already present
7. Fix any British English violations
8. Remove bold from inside <p> tags — move emphasis to sentence structure instead
9. Remove em dashes and en dashes — replace with commas or restructure the sentence

WHAT YOU MUST NOT DO:
- Do not change any facts, figures, costs, timelines, named regulators, or jurisdiction details
- Do not alter href values, target, or rel attributes on any <a> tag
- Do not remove existing H3/H4 headings — only add where missing
- Do not add new full sections or change the article's overall structure
- Do not add commentary, explanation, or preamble — return ONLY the fixed HTML

Return the complete fixed HTML. No markdown, no code fences, no explanation — just the raw HTML.

ARTICLE HTML:
${html}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      max_completion_tokens: 32000,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    if (raw) {
      rewrittenHtml = raw.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "").trim();
      aiFixSummary.push(
        `AI rewrite applied — fixed ${flaggedIssues.length} flagged issues + full quality pass`
      );
    }

    // ── Pass 2: Mechanical cleanup on the AI output ──────────────
    const mechanical = applyAutoFixes(rewrittenHtml, language ?? null);

    return NextResponse.json({
      html: mechanical.html,
      appliedFixes: [...aiFixSummary, ...mechanical.appliedFixes],
    });

  } catch (err: unknown) {
    console.error("[autofix] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Auto-fix failed" },
      { status: 500 }
    );
  }
}
