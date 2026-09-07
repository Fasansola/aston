/**
 * lib/research.ts
 * ─────────────────────────────────────────────────────────────
 * SEO research step — runs before the strategy engine.
 * Uses the Responses API's built-in web_search tool to pull real SERP data
 * for the topic: what's ranking, what questions people ask, what content
 * gaps exist. The ResearchBrief feeds into the strategy engine as grounded
 * context. The same helper discovers live authority URLs for the article.
 *
 * History: until 2026-09-07 both calls used the chat-completions model
 * gpt-4o-search-preview. OpenAI deprecated it (404 "has been deprecated"),
 * so every run silently wrote without live research and without discovered
 * authority links — the step is best-effort and only logged a warning.
 */

import OpenAI from "openai";
import {
  chatWithRetry, assertCompleted, extractJson, recordUsage, classifyLlmError, errorMessage,
  isReasoningModel, PRIMARY_MODEL, FALLBACK_MODEL,
} from "./llm";

// ── Web search via the Responses API ─────────────────────────

type SearchContextSize = "low" | "medium" | "high";

/**
 * Run one web-search-grounded prompt and return the model's text. Tries the
 * primary model, then the fallback, each with the current `web_search` tool
 * and then the older `web_search_preview` name, so a model or tool rename
 * degrades to the next combination instead of losing research for weeks
 * again. Billing/auth errors are thrown immediately (nothing else can work);
 * everything else falls through to the caller, which treats research as
 * best-effort.
 */
async function webSearchText(args: {
  label: string;
  prompt: string;
  contextSize: SearchContextSize;
  timeoutMs: number;
}): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const models = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])];
  const tools: OpenAI.Responses.Tool[] = [
    { type: "web_search", search_context_size: args.contextSize },
    { type: "web_search_preview", search_context_size: args.contextSize },
  ];
  let lastErr: unknown;
  for (const model of models) {
    for (const tool of tools) {
      try {
        const response = await openai.responses.create({
          model,
          input: args.prompt,
          tools: [tool],
          // The search tool does the heavy lifting; the model only condenses
          // what it found, so a light reasoning budget keeps this quick.
          ...(isReasoningModel(model) ? { reasoning: { effort: "low" as const } } : {}),
        }, { signal: AbortSignal.timeout(args.timeoutMs) });
        recordUsage({ kind: "chat", label: args.label, model, usage: response.usage });
        const text = (response.output_text ?? "").trim();
        if (!text) throw new Error(`${args.label}: empty response from ${model} with ${tool.type}`);
        return text;
      } catch (err) {
        lastErr = err;
        const fatal = classifyLlmError(err);
        if (fatal && (fatal.kind === "quota" || fatal.kind === "auth")) throw fatal;
        console.warn(`[${args.label}] ${model} + ${tool.type} failed (${fatal ? fatal.kind : "transient"}): ${errorMessage(err).slice(0, 200)}`);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${args.label}: web search failed`);
}

export interface ResearchBrief {
  serp_summary: string;
  dominant_keywords: string[];
  common_questions: string[];
  content_gaps: string;
  competitor_angles: string[];
  ranking_competitors: string[];
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

  // No max_completion_tokens: on gpt-5.5 reasoning tokens count against the
  // cap, and the old 2000 budget could be consumed entirely by reasoning —
  // returning an EMPTY message (finish_reason "length") and failing every
  // retry the same way. 120s primary: 60s was the tightest gpt-5.5 budget
  // in the pipeline and timed out on hard prompts.
  const response = await chatWithRetry(openai, {
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
  }, { label: "deriveTitle", timeoutMs: 120_000 });

  const raw = assertCompleted(response, "deriveTitle");
  return extractJson<{ title: string; topic: string }>(raw, "deriveTitle");
}

export interface DiscoveredLink {
  url: string;
  name: string;
  description: string;
}

/**
 * Use live web search to find real, topic-specific authority URLs. Returns
 * specific pages (not just homepages) from official sources relevant to the
 * article topic. Results are merged with the hardcoded authority list so GPT
 * always has unique, contextually accurate external links to draw from.
 *
 * Non-fatal — callers must catch and fall back to the hardcoded list.
 */
export async function findExternalAuthorityLinks(
  topic: string,
  primaryKeyword: string,
  jurisdictions: string[],
  count = 5
): Promise<DiscoveredLink[]> {
  const jurisdictionLine = jurisdictions.length > 0
    ? `Key jurisdictions: ${jurisdictions.slice(0, 5).join(", ")}`
    : "";

  const raw = await webSearchText({
    label: "authorityLinks",
    contextSize: "low",
    timeoutMs: 90_000,
    prompt: `Find ${count} real, specific, currently live URLs from authoritative sources for the following topic.

Topic: ${topic}
Primary keyword: ${primaryKeyword}
${jurisdictionLine}

Requirements:
- Sources must be official: government bodies, financial regulators, international institutions (OECD, IMF, BIS, FATF, World Bank), major regulatory frameworks
- Prefer specific pages or guidance documents over generic homepages (e.g. the FCA's page on payment institutions, not just fca.org.uk)
- All URLs must be real and currently accessible — no invented URLs
- Do not include competitor sites, news sites, blogs, or commercial product pages
- Cover a range of relevant angles: regulation, tax, banking, compliance, jurisdiction-specific guidance

Return a JSON array. No markdown, no code fences:
[
  { "url": "https://...", "name": "Authority name", "description": "one sentence on what this page covers and why it is relevant to the topic" }
]`,
  });

  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as DiscoveredLink[];
    // Validate each URL parses as a real https URL, then dedupe by normalised
    // href so the approved-link set never carries malformed or duplicate entries.
    // Dead links that still parse are caught later by scrubBrokenExternalLinks.
    const seen = new Set<string>();
    const valid: DiscoveredLink[] = [];
    for (const l of parsed) {
      if (typeof l.url !== "string") continue;
      let normalised: string;
      try {
        const u = new URL(l.url);
        if (u.protocol !== "https:" && u.protocol !== "http:") continue;
        normalised = u.href.replace(/\/$/, "").toLowerCase();
      } catch {
        continue; // not a parseable URL — drop it
      }
      if (seen.has(normalised)) continue;
      seen.add(normalised);
      valid.push(l);
    }
    return valid;
  } catch {
    return [];
  }
}

export async function researchTopic(
  topic: string,
  primaryCountry?: string,
  customPrompt?: string
): Promise<ResearchBrief> {
  const contextLines = [
    `Topic: ${topic}`,
    primaryCountry ? `Primary jurisdiction: ${primaryCountry}` : "",
    customPrompt ? `Additional context: ${customPrompt}` : "",
  ].filter(Boolean).join("\n");

  const raw = await webSearchText({
    label: "research",
    // "medium" context indexes more pages — important for Aston's niche
    // regulatory topics where the relevant sources are not top-of-SERP.
    contextSize: "medium",
    timeoutMs: 150_000,
    prompt: `${contextLines}

You are an SEO researcher for a high-end corporate advisory blog. Research the current search landscape for the topic above and return a JSON object. No markdown, no code fences.

{
  "serp_summary": "paragraph describing what types of content currently rank for this topic — informational guides, comparison pages, official regulator pages, news, etc. — and the general quality level of the top results",
  "dominant_keywords": ["8 to 12 keyword phrases that appear most commonly across top-ranking results"],
  "common_questions": ["10 to 15 questions appearing in People Also Ask boxes, forums, and top-ranking FAQs for this topic"],
  "content_gaps": "paragraph describing what top-ranking results miss or oversimplify — specific angles they fail to cover that a genuinely authoritative article should address",
  "competitor_angles": ["5 to 8 specific content angles or hooks used by the current top-ranking pages"],
  "ranking_competitors": ["3 to 8 specific firms, brands, or publications that currently rank on page one for this topic — name them (e.g. a Big Four firm, a named law firm, a government portal, a competitor advisory). This shows who Aston VIP must outrank"],
  "seo_recommendations": "paragraph with specific SEO recommendations for this topic — what keyword emphasis, structural depth, authority signals, and content scope would help outrank current results"
}`,
  });

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
