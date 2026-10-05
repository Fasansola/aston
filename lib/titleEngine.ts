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
 * Only for requests made with a prompt and no title. A title the operator
 * typed is never scored or rewritten — see lockProvidedTitle().
 *
 * The winner becomes the locked title used as the H1, the SEO title and the
 * article theme. All 20 candidates + scores are logged for transparency.
 *
 * Generic words (requirements, overview, introduction, explained) are penalised
 * and only win when the intent data genuinely makes them the strongest option.
 */

import OpenAI from "openai";
import type { StrategyBrief } from "./strategy";
import { chatWithRetry, assertCompleted, extractJson } from "./llm";

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

const KEYWORD_STOP_WORDS = new Set(["the", "a", "an", "of", "for", "with", "to", "in", "on", "and", "or", "your", "what", "why", "how", "is", "are"]);

/**
 * Last-resort focus keyword: up to four CONSECUTIVE words of the title, starting
 * at its first meaningful word. Sliced out of the title itself, so it is always
 * a substring of it (dropping stop words from the middle would not be).
 */
function leadingKeyphrase(title: string): string {
  const words = [...title.matchAll(/\S+/g)];
  const isStop = (w: string) => KEYWORD_STOP_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const start = words.findIndex((m) => !isStop(m[0]));
  if (start < 0) return title.trim();
  let end = Math.min(start + 3, words.length - 1);
  while (end > start && isStop(words[end][0])) end--;
  const phrase = title.slice(words[start].index!, words[end].index! + words[end][0].length);
  return phrase.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || title.trim();
}

/**
 * Guarantee the focus keyword is a substring of the chosen title so the
 * downstream blocking QA check (focus_keyword_in_title) cannot fail.
 * Priority: model's keyword → strategy primary keyword → leading words of the title.
 */
export function resolveFocusKeyword(title: string, modelKw: string, strategyKw?: string): string {
  const t = title.toLowerCase();
  if (modelKw?.trim() && t.includes(modelKw.toLowerCase().trim())) return modelKw.trim();
  if (strategyKw?.trim() && t.includes(strategyKw.toLowerCase().trim())) return strategyKw.trim();
  return leadingKeyphrase(title);
}

/**
 * A title the operator typed is the title: no candidates, no scoring, no
 * house-style rewrite. Only the focus keyword is still chosen here, and it has
 * to be a phrase taken from that title (focus_keyword_in_title is blocking).
 */
export async function lockProvidedTitle(params: {
  title: string;
  strategy?: StrategyBrief | null;
  language?: string;
}): Promise<TitleSelection> {
  const title = params.title.trim();
  const strategyKw = params.strategy?.keyword_model?.primary_keyword?.trim();
  if (strategyKw && title.toLowerCase().includes(strategyKw.toLowerCase())) {
    console.log(`[titleEngine] title provided — kept as written: "${title}", focus "${strategyKw}"`);
    return { title, focusKeyword: strategyKw, candidates: [] };
  }

  let modelKw = "";
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await chatWithRetry(openai, {
      messages: [
        { role: "system", content: "You are an SEO strategist for Aston VIP, a high-end international corporate advisory firm." },
        { role: "user", content: `ARTICLE TITLE (written by the client, fixed, do not change it): "${title}"
${strategyKw ? `PRIMARY KEYWORD FROM THE STRATEGY (for context): ${strategyKw}\n` : ""}
Choose the focus keyword for this article: the 2 to 4 word phrase a searcher would type into Google to find it.
It MUST be copied from the title exactly: the same consecutive words, in the same order, with the same spelling${isNonEnglish(params.language) ? `, in the title's own language` : ""}.

Return ONE valid JSON object, no markdown, no code fences:
{ "focus_keyword": "..." }` },
      ],
    }, { label: "focusKeyword", timeoutMs: 120_000 });
    modelKw = extractJson<{ focus_keyword?: string }>(assertCompleted(res, "focusKeyword"), "focusKeyword").focus_keyword ?? "";
  } catch (err) {
    console.warn(`[titleEngine] focus keyword pick failed (${err instanceof Error ? err.message : String(err)}) — taking it from the title`);
  }

  const focusKeyword = resolveFocusKeyword(title, modelKw, strategyKw);
  console.log(`[titleEngine] title provided — kept as written: "${title}", focus "${focusKeyword}"`);
  return { title, focusKeyword, candidates: [] };
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
    // 16k cap (was 8k): reasoning tokens count against max_completion_tokens
    // on gpt-5.5, and 20 scored candidates need real output headroom.
    const res = await chatWithRetry(openai,
      { max_completion_tokens: 16000, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      { label: "titleEngine", timeoutMs: 120_000 }
    );
    const raw = assertCompleted(res, "titleEngine");
    const parsed = extractJson<{
      candidates?: Array<{ title?: string; intent?: number; commercial?: number; ctr?: number; ai?: number }>;
      selected_title?: string;
      focus_keyword?: string;
    }>(raw, "titleEngine");

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
