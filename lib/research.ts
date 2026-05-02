/**
 * lib/research.ts
 * ─────────────────────────────────────────────────────────────
 * SEO research step — runs before the strategy engine.
 * Uses gpt-4o-search-preview to pull real SERP data for the topic:
 * what's ranking, what questions people ask, what content gaps exist.
 * The ResearchBrief feeds into the strategy engine as grounded context.
 */

import OpenAI from "openai";

export interface ResearchBrief {
  serp_summary: string;
  dominant_keywords: string[];
  common_questions: string[];
  content_gaps: string;
  competitor_angles: string[];
  seo_recommendations: string;
}

/**
 * Given a freeform user prompt (no title provided), derive a single
 * SEO-optimised article title and a clean topic string to drive the pipeline.
 */
export async function deriveTitle(
  customPrompt: string,
  primaryCountry?: string
): Promise<{ title: string; topic: string }> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contextLines = [
    `User prompt: ${customPrompt}`,
    primaryCountry ? `Primary jurisdiction: ${primaryCountry}` : "",
  ].filter(Boolean).join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an SEO strategist for Aston VIP, a high-end international corporate advisory firm. Given a freeform content request, derive the best possible SEO-optimised blog title and a clean topic phrase for the article. British English. No dashes in the title. Sentence case only.`,
      },
      {
        role: "user",
        content: `${contextLines}

Return a JSON object. No markdown, no code fences.

{
  "title": "The exact article title — natural, clear, no dashes, sentence case, 6-12 words, SEO-optimised for the core subject",
  "topic": "A short 3-6 word phrase summarising the core topic — used as input to the strategy engine"
}`,
      },
    ],
    temperature: 0.3,
    max_completion_tokens: 200,
  }, { signal: AbortSignal.timeout(30_000) });

  const raw = response.choices[0].message.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in deriveTitle response. Raw: ${raw.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]) as { title: string; topic: string };
  } catch {
    throw new Error(`deriveTitle returned invalid JSON. Raw: ${raw.slice(0, 200)}`);
  }
}

export async function researchTopic(
  topic: string,
  primaryCountry?: string,
  customPrompt?: string
): Promise<ResearchBrief> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const contextLines = [
    `Topic: ${topic}`,
    primaryCountry ? `Primary jurisdiction: ${primaryCountry}` : "",
    customPrompt ? `Additional context: ${customPrompt}` : "",
  ].filter(Boolean).join("\n");

  const response = await (openai.chat.completions.create as Function)({
    model: "gpt-4o-search-preview",
    web_search_options: { search_context_size: "medium" },
    messages: [
      {
        role: "user",
        content: `${contextLines}

You are an SEO researcher for a high-end corporate advisory blog. Research the current search landscape for the topic above and return a JSON object. No markdown, no code fences.

{
  "serp_summary": "paragraph describing what types of content currently rank for this topic — informational guides, comparison pages, official regulator pages, news, etc. — and the general quality level of the top results",
  "dominant_keywords": ["8 to 12 keyword phrases that appear most commonly across top-ranking results"],
  "common_questions": ["10 to 15 questions appearing in People Also Ask boxes, forums, and top-ranking FAQs for this topic"],
  "content_gaps": "paragraph describing what top-ranking results miss or oversimplify — specific angles they fail to cover that a genuinely authoritative article should address",
  "competitor_angles": ["5 to 8 specific content angles or hooks used by the current top-ranking pages"],
  "seo_recommendations": "paragraph with specific SEO recommendations for this topic — what keyword emphasis, structural depth, authority signals, and content scope would help outrank current results"
}`,
      },
    ],
  }, { signal: AbortSignal.timeout(60_000) });

  const raw = response.choices[0].message.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in research response. Raw: ${raw.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]) as ResearchBrief;
  } catch {
    throw new Error(`Research returned invalid JSON. Raw: ${raw.slice(0, 200)}`);
  }
}
