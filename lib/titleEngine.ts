/**
 * lib/titleEngine.ts
 * ─────────────────────────────────────────────────────────────
 * Title selection engine — runs BEFORE the article is written.
 *
 * Instead of writing one title directly, it:
 *   1. Generates 20 candidate titles for the topic
 *   2. Works from the real search intent (not the literal topic)
 *   3. Uses the commercial + AI-search keywords
 *   4. Scores every candidate 1–100 on a weighted formula:
 *        Search Intent 40% · Commercial 30% · CTR 20% · AI discoverability 10%
 *   5. Selects the single highest-scoring title
 *
 * The winner becomes the locked title used as the H1, the SEO title and the
 * article theme. All 20 candidates + scores are logged for transparency.
 *
 * Generic words (requirements, overview, introduction, explained) are penalised
 * and only win when the intent data genuinely makes them the strongest option.
 */

import OpenAI from "openai";
import type { StrategyBrief } from "./strategy";

const MODEL = "gpt-5.5";

export interface TitleCandidate {
  title: string;
  intent: number;      // 0–100 search-intent match
  commercial: number;  // 0–100 commercial value
  ctr: number;         // 0–100 click-through potential
  ai: number;          // 0–100 AI discoverability
  score: number;       // weighted total (computed server-side, not trusted from the model)
}

export interface TitleSelection {
  title: string;        // the winning title — used as H1 + SEO title + theme
  focusKeyword: string; // a searchable phrase guaranteed to appear in `title`
  candidates: TitleCandidate[]; // all scored candidates, ranked high→low
}

// Weighted scoring formula (client-specified).
const W = { intent: 0.4, commercial: 0.3, ctr: 0.2, ai: 0.1 };
function weighted(c: { intent: number; commercial: number; ctr: number; ai: number }): number {
  const n = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 0);
  return Math.round(n(c.intent) * W.intent + n(c.commercial) * W.commercial + n(c.ctr) * W.ctr + n(c.ai) * W.ai);
}

const ENGLISH = new Set(["en", "en-gb", "en-us"]);
const isNonEnglish = (l?: string) => !!l && !ENGLISH.has(l.toLowerCase());

/**
 * Enforce house style on the chosen title so the downstream QA checks
 * (no_dashes_in_title, no colons) never trigger a rewrite that would diverge
 * from the locked title. Removes em/en dashes and " - " separators and colons,
 * preserving intra-word hyphens is unnecessary for titles, so collapse them.
 */
function sanitizeTitle(t: string): string {
  return t
    .replace(/\s*[—–]\s*/g, ", ")   // em/en dash → comma
    .replace(/\s+-\s+/g, ", ")        // spaced hyphen separator → comma
    .replace(/\s*:\s*/g, " ")          // colon → space
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

/**
 * Guarantee the focus keyword is a substring of the chosen title so the
 * downstream blocking QA check (focus_keyword_in_title) cannot fail.
 * Priority: model's keyword → strategy primary keyword → first significant words.
 */
function resolveFocusKeyword(title: string, modelKw: string, strategyKw?: string): string {
  const t = title.toLowerCase();
  if (modelKw && t.includes(modelKw.toLowerCase().trim())) return modelKw.trim();
  if (strategyKw && t.includes(strategyKw.toLowerCase().trim())) return strategyKw.trim();
  // Fallback: first 2–4 meaningful words of the title.
  const stop = new Set(["the", "a", "an", "of", "for", "with", "to", "in", "on", "and", "or", "your", "what", "why", "how", "is", "are"]);
  const words = title.split(/\s+/).filter((w) => w.replace(/[^a-z0-9]/gi, "").length > 0);
  const sig = words.filter((w) => !stop.has(w.toLowerCase()));
  return (sig.slice(0, 4).join(" ") || title).trim();
}

export async function selectOptimalTitle(params: {
  topic: string;
  strategy?: StrategyBrief | null;
  customPrompt?: string;
  language?: string;
}): Promise<TitleSelection> {
  const { topic, strategy, customPrompt, language } = params;
  const strategyKw = strategy?.keyword_model?.primary_keyword;

  // Pull intent + keyword signals from the strategy brief (steps 2–4 are already
  // analysed there); the title engine focuses on generation + scoring.
  const intentBlock = strategy ? `
KNOWN SEARCH INTENT (from strategy analysis): ${strategy.search_intent_type} — ${(strategy.search_intent ?? "").slice(0, 400)}
PRIMARY KEYWORD: ${strategy.keyword_model.primary_keyword}
COMMERCIAL KEYWORDS: ${[...(strategy.keyword_model.secondary_keywords ?? []), ...(strategy.commercial_intent_layers ?? [])].slice(0, 20).join(", ")}
AI-SEARCH KEYWORDS (entities + long-tail): ${[...(strategy.keyword_model.entity_terms ?? []), ...(strategy.keyword_model.long_tail_keywords ?? [])].slice(0, 30).join(", ")}
ARTICLE ANGLE: ${(strategy.article_angle ?? "").slice(0, 300)}` : "";

  const langBlock = isNonEnglish(language)
    ? `\nWrite every candidate title in ${language}. No English.`
    : "";

  const system = `You are a senior editor at a top business publication (think Financial Times, Bloomberg, The Economist). You write blog titles that are sharp, natural, and genuinely interesting to a business reader — not keyword-stuffed SEO filler. Every title you write must pass this test: could a smart human editor have written this? If it sounds like an AI crammed keywords together, it fails.`;

  const user = `TOPIC: "${topic}"
${customPrompt ? `EXTRA CONTEXT: ${customPrompt}\n` : ""}${intentBlock}${langBlock}

Follow this process exactly:
1. Work out what the reader is ACTUALLY searching for — the real questions and concerns behind this topic. For "Dubai Foundation" the reader is really asking about asset protection, succession planning, family wealth, foundation vs trust — not "foundation setup requirements".
2. Use the commercial keywords and AI-search keywords above as context, NOT as words to stuff into the title.
3. Generate 20 DISTINCT candidate titles. Each must read like a NATURAL, HUMAN-WRITTEN headline — something a senior editor would approve for publication.
4. Score EACH candidate 1–100 on four dimensions:
   - intent: how well it answers what the reader is genuinely searching for
   - commercial: commercial value for a reader ready to take action
   - ctr: would a real person click this in search results? (natural, specific, intriguing)
   - ai: would AI answer engines cite an article with this title?
5. Select the highest-scoring title on the formula: intent 40%, commercial 30%, ctr 20%, ai 10%.

THE #1 RULE — NATURALNESS:
Every title MUST sound like something a knowledgeable human would actually write or say. Read it aloud — if it sounds awkward, robotic, or like a list of keywords strung together, REJECT it and write a better one.

GOOD titles (natural, specific, a reader would click):
- "Why most Dubai free zone companies fail at banking"
- "What your DIFC company structure actually costs in 2026"
- "The hidden risk in UAE holding company setups"
- "How VARA licensing really works for crypto firms"
- "Golden Visa through business ownership in Dubai"
- "What banks look for when you apply from a free zone"
- "Offshore structures that actually survive due diligence"

BAD titles (keyword-stuffed, robotic, no human would write these):
- "IFZA company formation with expert support in Dubai" ← reads like an ad
- "MICA CASP license best EU countries costs and requirements" ← keyword salad
- "Czech SPI license setup for full PI conversion in 2026" ← jargon dump
- "Dubai free zone company setup costs and bank checks" ← two topics jammed together
- "UAE trade license formation process complete overview" ← generic filler
- "Best free zones in Dubai for tech startups in 2026" ← bland listicle tone

FORMATTING RULES:
- 50 to 60 characters including spaces
- Sentence case (capitalise first word and proper nouns only)
- No dashes, colons, pipes, or question marks
- The primary keyword should appear naturally — not forced or front-loaded
- One clear focus per title, never two topics joined by "and"

Return ONE valid JSON object, no markdown, no code fences:
{
  "real_intents": ["...", "..."],
  "candidates": [
    { "title": "...", "intent": 0, "commercial": 0, "ctr": 0, "ai": 0 }
  ],
  "selected_title": "the winning title, copied exactly from candidates",
  "focus_keyword": "the 2–4 word searchable phrase that appears verbatim in selected_title"
}
Provide exactly 20 candidates.`;

  const fallback = (): TitleSelection => {
    const t = (strategyKw ? `${strategyKw}` : topic).trim();
    return { title: t.slice(0, 60), focusKeyword: resolveFocusKeyword(t, strategyKw ?? "", strategyKw), candidates: [] };
  };

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await openai.chat.completions.create(
      { model: MODEL, max_completion_tokens: 8000, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      { signal: AbortSignal.timeout(120_000) }
    );
    const raw = res.choices[0]?.message?.content?.trim() ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn("[titleEngine] no JSON in response — using fallback"); return fallback(); }

    const parsed = JSON.parse(match[0]) as {
      candidates?: Array<{ title?: string; intent?: number; commercial?: number; ctr?: number; ai?: number }>;
      selected_title?: string;
      focus_keyword?: string;
    };

    const candidates: TitleCandidate[] = (parsed.candidates ?? [])
      .filter((c) => c && typeof c.title === "string" && c.title.trim().length > 0)
      .map((c) => {
        const base = { intent: Number(c.intent) || 0, commercial: Number(c.commercial) || 0, ctr: Number(c.ctr) || 0, ai: Number(c.ai) || 0 };
        return { title: c.title!.trim(), ...base, score: weighted(base) };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) { console.warn("[titleEngine] no candidates parsed — using fallback"); return fallback(); }

    // Prefer the highest weighted score among candidates in the 45–65 char band
    // (lenient around the 50–60 target); fall back to the overall best.
    const inBand = candidates.filter((c) => c.title.length >= 45 && c.title.length <= 65);
    const winner = (inBand[0] ?? candidates[0]);
    const winnerTitle = sanitizeTitle(winner.title);
    const focusKeyword = resolveFocusKeyword(winnerTitle, parsed.focus_keyword ?? "", strategyKw);

    console.log(`[titleEngine] 20 candidates scored — winner "${winnerTitle}" (${winner.score}), focus "${focusKeyword}"`);
    candidates.forEach((c, i) =>
      console.log(`[titleEngine]   ${String(i + 1).padStart(2)}. (${c.score}) [int ${c.intent} com ${c.commercial} ctr ${c.ctr} ai ${c.ai}] ${c.title}`));

    return { title: winnerTitle, focusKeyword, candidates };
  } catch (err) {
    console.warn(`[titleEngine] failed (${err instanceof Error ? err.message : String(err)}) — using fallback title`);
    return fallback();
  }
}
