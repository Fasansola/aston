/**
 * app/api/autofix/route.ts
 * POST /api/autofix
 *
 * Two-pass fix pipeline:
 *  Pass 1 — GPT rewrites the HTML to fix all readiness issues (readability,
 *            transitions, sentence length, passive voice, keyword density, etc.)
 *  Pass 2 — Mechanical cleanup (US spellings, heading case, bold in paragraphs,
 *            decorative symbols) runs on GPT's output as a final safety net.
 */

import { NextRequest, NextResponse } from "next/server";
import { applyAutoFixes } from "@/lib/readinessValidator";
import OpenAI from "openai";

export const maxDuration = 60;

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
    const { html, language, issues } = await req.json();

    if (!html?.trim()) {
      return NextResponse.json({ error: "html is required" }, { status: 400 });
    }

    // ── Pass 1: AI rewrite targeting all flagged issues ──────────
    let rewrittenHtml = html;
    const aiFixSummary: string[] = [];

    if (Array.isArray(issues) && issues.length > 0) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const issueList = issues
        .filter((i: { severity: string }) => i.severity !== "passed")
        .map((i: { message: string; suggestedFix?: string }) =>
          i.suggestedFix ? `• ${i.message} → Fix: ${i.suggestedFix}` : `• ${i.message}`
        )
        .join("\n");

      const prompt = `You are an expert SEO copyeditor. You will be given the HTML of a blog article and a list of issues detected by a readiness checker. Your job is to fix every issue listed while preserving everything that is already correct.

ISSUES TO FIX:
${issueList}

RULES — you MUST follow all of these:
- Fix every issue listed above. Do not skip any.
- Preserve ALL HTML tags, structure, headings, and hierarchy exactly — only change text content and inline formatting where required by the issues
- Preserve ALL links (<a href="...">...</a>) including href values, target, and rel attributes — only update anchor text if "weak anchor text" is listed as an issue
- Preserve all facts, figures, costs, timelines, named regulators, and jurisdiction details — do not invent or change any factual content
- UK English throughout: organisation, licence (noun), authorise, centre, optimise, travelling
- Sentence case for all headings — capitalise only the first word and proper nouns (DIFC, ADGM, UAE, VARA, UK, etc.)
- No bold inside <p> tags — bold is for headings only
- Transition words: ensure at least one transition per three sentences (however, therefore, because, as a result, for example, in addition, in practice, by contrast, more importantly, in most cases)
- Sentence length: aim for 15–20 words. Split any sentence over 25 words into two
- Active voice: rewrite passive constructions to active voice (e.g. "the licence is issued by" → "the regulator issues")
- No em dashes or en dashes — use commas or restructure
- No decorative symbols (→, ★, ✓, etc.)
- Do NOT add new sections, headings, or change the article's word count significantly
- Do NOT add any commentary, explanation, or preamble — return ONLY the fixed HTML

Return the complete fixed HTML article. No markdown, no code fences, no explanation — just the raw HTML.

ARTICLE HTML TO FIX:
${html}`;

      const response = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_completion_tokens: 16000,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? "";
      if (raw) {
        // Strip any accidental code fences the model adds
        rewrittenHtml = raw.replace(/^```(?:html)?\n?/, "").replace(/\n?```$/, "").trim();
        aiFixSummary.push(`AI rewrite applied — fixed ${issues.filter((i: { severity: string }) => i.severity !== "passed").length} readiness issues`);
      }
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
