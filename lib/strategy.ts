/**
 * lib/strategy.ts
 * ─────────────────────────────────────────────────────────────
 * Master Blog Strategy Engine — 12-step analysis that runs before
 * any article writing begins. Produces a StrategyBrief used by the
 * blueprint and content generators as their source of truth.
 */

import OpenAI from "openai";
import { ResearchBrief } from "./research";

export interface StrategyInputs {
  topic: string;        // required
  audience?: string;    // required at API boundary — defines tone, complexity, commercial angle
  primary_country?: string;
  secondary_countries?: string;
  priority_service?: string;
  language?: string;
  customPrompt?: string;  // freeform user instruction injected before strategy analysis
  research?: ResearchBrief; // live SERP data from the research step
}

export type StrategyContext = Omit<StrategyInputs, "topic">;

export interface StrategyBrief {
  // Step 1
  core_topic_interpretation: string;
  // Step 2
  search_intent_type: "informational" | "commercial" | "transactional" | "mixed";
  search_intent: string;
  // Step 3
  commercial_intent_layers: string[];
  // Step 4
  jurisdiction_map: Array<{ jurisdiction: string; relevance: string }>;
  // Step 5
  regulatory_frameworks: Array<{ framework: string; relevance: string }>;
  // Step 6
  keyword_model: {
    primary_keyword: string;
    primary_keyword_why: string;
    primary_alternatives: string[];
    secondary_keywords: string[];
    long_tail_keywords: string[];
    entity_terms: string[];
    question_queries: string[];
  };
  // Step 7
  banking_tax_structuring_compliance: {
    banking: string;
    tax: string;
    structuring: string;
    compliance: string;
  };
  // Step 8
  high_value_strategy: string;
  // Step 8.5
  key_takeaways: string[];
  // Step 9
  internal_link_plan: string;
  // Step 10
  external_link_plan: string;
  // Step 11
  article_angle: string;
  // Step 12
  content_risks: string[];
}

const STRATEGY_SYSTEM_PROMPT = `You are:
- a senior SEO strategist
- a professional blog writer
- a cross-border corporate structuring advisor
- a financial services content expert
- an internal linking strategist
- an external authority-link strategist
- a publishing and UX-aware content architect

You are writing for Aston VIP — a global advisory firm that works across multiple jurisdictions and multiple service layers, including: nominee structures, nominee directors, nominee shareholders, corporate banking, private banking, tax positioning, tax residency, business setup, cross-border structuring, offshore and international structures, licensing and regulation, DIFC, ADGM, DFSA, VARA, and UK, UAE, European, Asian and offshore structures where relevant.

Your job is to prepare the full strategic foundation for a high-end blog article that:
- ranks in traditional search engines
- performs well in AI answer engines
- reflects real advisory thinking
- matches Aston VIP's service reality
- supports internal linking and site architecture
- uses external authority links correctly
- follows strict editorial, linguistic and structural standards
- reads like a premium editorial article, not generic AI content

You are NOT doing generic keyword research. You are NOT generating cheap listicle content. You are NOT creating thin SEO filler. You are building the strategic foundation for a serious article that should feel commercially intelligent, editorially strong, and useful to readers making real decisions.

LANGUAGE AND EDITORIAL STANDARD:
- Default to British English unless a language input is provided
- British spelling: organisation, optimisation, licence (noun), authorised, centre, adviser, travelling
- Sentence case for all headings — do NOT use American title case
- Do NOT use colons in headings or section labels
- Do NOT use dashes (em dash, en dash, or hyphens) in article titles
- Do NOT bold random words inside body paragraphs
- Write in flowing, readable paragraphs — do not overuse bullets
- The article must feel structured, clear, human, professional, and commercially aware`;

export async function generateStrategy(inputs: StrategyInputs): Promise<StrategyBrief> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const inputLines = [
    `TOPIC: ${inputs.topic}`,
    inputs.audience             ? `TARGET_AUDIENCE: ${inputs.audience}`             : "",
    inputs.primary_country      ? `PRIMARY_COUNTRY: ${inputs.primary_country}`      : "",
    inputs.secondary_countries  ? `SECONDARY_COUNTRIES: ${inputs.secondary_countries}` : "",
    inputs.priority_service     ? `PRIORITY_SERVICE: ${inputs.priority_service}`    : "",
    inputs.language             ? `LANGUAGE: ${inputs.language}`                    : "",
  ].filter(Boolean).join("\n");

  const customPromptBlock = inputs.customPrompt?.trim()
    ? `\nCUSTOM INSTRUCTIONS (highest priority — follow these precisely throughout the entire analysis):\n${inputs.customPrompt.trim()}\n`
    : "";

  const researchBlock = inputs.research
    ? `\nSERP RESEARCH (live data — use this as ground truth for keyword choices and content gaps):\nSERP summary: ${inputs.research.serp_summary}\nDominant keywords found in top results: ${inputs.research.dominant_keywords.join(", ")}\nCommon questions in SERPs: ${inputs.research.common_questions.slice(0, 10).join(" | ")}\nContent gaps in current top results: ${inputs.research.content_gaps}\nCompetitor angles to be aware of: ${inputs.research.competitor_angles.join("; ")}\nSEO recommendations from research: ${inputs.research.seo_recommendations}\n`
    : "";

  const userPrompt = `${inputLines}${customPromptBlock}${researchBlock}

Run the full 12-step strategy analysis for this topic and return the result as a single valid JSON object. No markdown, no code fences.

{
  "core_topic_interpretation": "full paragraph — what this topic is really about beyond the surface keyword, what problem the reader is solving, what commercial, legal, banking, tax or structuring decision they are likely trying to make, whether the topic is broader than it first appears, and whether it is often misunderstood or oversimplified",
  "search_intent_type": "informational | commercial | transactional | mixed",
  "search_intent": "detailed paragraph — why this classification is correct, what the reader is trying to achieve, whether they are researching or close to action, whether the query contains hidden commercial intent",
  "commercial_intent_layers": [
    "service layer name — whether it applies, why it applies, and how it changes the article strategy"
  ],
  "jurisdiction_map": [
    { "jurisdiction": "country or zone name", "relevance": "why it matters and how it affects tax, banking, licensing, privacy, or regulatory outcomes for this topic" }
  ],
  "regulatory_frameworks": [
    { "framework": "regulator or framework name", "relevance": "what it governs, why it matters for this topic, whether the article will likely need an external authority link to support it" }
  ],
  "keyword_model": {
    "primary_keyword": "the strongest main keyword for the article",
    "primary_keyword_why": "one sentence explaining why this is the best primary keyword",
    "primary_alternatives": ["3 to 5 close alternatives reflecting real search phrasing — not awkward variants"],
    "secondary_keywords": ["12 to 20 relevant secondary keywords including service variants, jurisdiction variants, and commercial-intent variants"],
    "long_tail_keywords": ["15 to 25 realistic long-tail queries including decision-making phrases, cross-border angles, and tax, banking, structuring or nominee angles where relevant"],
    "entity_terms": ["20 to 35 important semantic terms: regulators, cities, countries, licence terms, banking concepts, governance concepts, tax concepts, legal concepts, compliance concepts"],
    "question_queries": ["15 to 25 natural user questions reflecting both Google-type searches and AI answer-engine style queries — these should help shape sections that answer real decision questions"]
  },
  "banking_tax_structuring_compliance": {
    "banking": "full paragraph on banking implications: whether the structure or jurisdiction affects account opening, whether compliance documentation matters, whether banks see this as simple, moderate or high risk, whether banking needs to be planned before the legal structure is finalised",
    "tax": "full paragraph on tax implications: corporate tax, personal tax, withholding tax, reporting or residency matters, whether zero-tax assumptions are misleading, whether cross-border tax exposure remains relevant even if one jurisdiction looks attractive",
    "structuring": "full paragraph on structuring implications: whether the topic is about operating entities, holding entities, ownership layers, SPVs, nominee frameworks or jurisdiction pairing, whether one-jurisdiction structures are weak compared with multi-jurisdiction structures in this context",
    "compliance": "full paragraph on compliance implications: AML, reporting, licensing maintenance, governance, substance or disclosure, whether compliance is one-off or ongoing, whether the topic should be framed as a long-term compliance issue rather than a setup-only issue"
  },
  "high_value_strategy": "full paragraph on what would make this article genuinely high-value: what weak competitors usually miss, what most surface-level articles oversimplify, what Aston VIP should cover to be better than them, what makes the article commercially strong, what makes it useful for both classic search and AI retrieval systems",
  "key_takeaways": [
    "standalone advisory sentence — a real insight that helps a reader understand something important and reflects real decision-making, risk, structure, banking, tax, licensing, regulation or jurisdiction logic",
    "standalone advisory sentence",
    "standalone advisory sentence",
    "standalone advisory sentence"
  ],
  "internal_link_plan": "full paragraph on how many internal links the article should contain (target 3 to 10 per 1,000 words), where they should appear across the article, which service clusters should be linked, what supporting content themes should be linked, what type of anchor text should be used, where the first internal link should likely appear, which service or page clusters should be prioritised, and how to prevent over-linking or repetitive linking",
  "external_link_plan": "full paragraph on whether external links are actually needed, which sections require official validation, which regulators or institutions should likely be referenced, what type of claim needs official support, which parts of the article do NOT need external links, and how to keep external links selective and authoritative — only real official sources, inserted inside sentences, never invented",
  "article_angle": "one full paragraph that is the final strategic positioning statement for the article: what it should really be about, how broad or narrow it should be, what decision it should help the reader make, what cross-border context must be included, what service layers must be present, what tone it should carry, and what commercial angle should be woven through the article",
  "content_risks": [
    "specific risk this writer must avoid for this particular topic"
  ]
}

FIELD INTERACTION RULES — these fields are NOT independent. They work together:
- TOPIC + TARGET_AUDIENCE defines the core subject AND who the article is written for (tone, complexity, examples, commercial angle all depend on audience)
- TOPIC + PRIMARY_COUNTRY: the entire article must anchor around this country — all tax, banking, regulation, examples, and structuring logic must prioritise this jurisdiction
- SECONDARY_COUNTRIES: used for comparison only — they must not take over the article
- PRIORITY_SERVICE: tells the system which Aston VIP service to emphasise — affects internal linking, commercial angle, section focus, and conversion intent
- LANGUAGE: controls the writing language AND grammar standard AND writing style — this is NOT translation. The article must sound like a native writer from that country. Output all text values (headings, sentences, descriptions) in the specified language.
- Combined example: TOPIC=crypto licence, PRIMARY_COUNTRY=UAE, LANGUAGE=German → write in German, focus on UAE regulation, use German phrasing and terminology — not translated English

FALLBACK LOGIC — when fields are missing:
- No LANGUAGE → default to British English throughout
- No PRIMARY_COUNTRY → use a global or cross-border angle; do not default to UAE
- No PRIORITY_SERVICE → infer the most relevant Aston VIP service from the topic itself

Rules:
- key_takeaways: exactly 4 to 6 items. Each must be a standalone advisory sentence with real decision-useful content. Not marketing copy. Not vague summaries. Must contain specific insight about structure, banking, tax, licensing, regulation, or jurisdiction logic.
- commercial_intent_layers: only include service layers that genuinely apply. Do not force irrelevant services. Do not miss obvious strategic connections.
- jurisdiction_map: only include jurisdictions that materially affect this article's strategic value. Do not list countries just to look global.
- regulatory_frameworks: only include frameworks that are actually relevant to this topic.
- content_risks: 5 to 10 specific risks for this particular topic — not generic writing advice.
- All output must be specific to this topic. Generic output is incorrect.
- If PRIMARY_COUNTRY is provided, anchor the analysis around that country first.
- If SECONDARY_COUNTRIES are provided, use them only for comparison — they must not replace the primary country as the main focus.
- If LANGUAGE is provided, ensure keywords and questions reflect native search behaviour in that language, not literal translations.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: STRATEGY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    max_completion_tokens: 16000,
  }, { signal: AbortSignal.timeout(90_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Strategy response was cut off by the token limit. Increase max_completion_tokens.");
  }

  const raw = choice.message.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in strategy response. Raw: ${raw.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]) as StrategyBrief;
  } catch {
    throw new Error(`Strategy returned invalid JSON. Raw: ${raw.slice(0, 200)}`);
  }
}
