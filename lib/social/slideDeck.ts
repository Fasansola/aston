/**
 * lib/social/slideDeck.ts
 * Writes the COPY for a text-on-image carousel (5–7 slides) in Aston's voice.
 * The images themselves are rendered programmatically (slideRender.ts) — the
 * model never draws text, it only writes it, so nothing is ever misspelled.
 *
 * Deck shape: a scroll-stopping cover, one idea per middle slide, and a CTA
 * close. Per the account's model constraints, gpt-5.x is called WITHOUT a
 * temperature.
 */

import OpenAI from "openai";
import { chatWithRetry, assertCompleted, extractJson } from "@/lib/llm";
import { PERSONA_BLOCK, COMPLIANCE_BLOCK, FIRM } from "@/lib/social/persona";

export interface Slide {
  kind: "cover" | "point" | "cta";
  /** Big display headline. Cover ≤ 8 words; point/cta ≤ 6. Rendered in caps. */
  title: string;
  /** Supporting sentence(s), ≤ 40 words. Cover may omit it. */
  body?: string;
}

export interface SlideDeck {
  topic: string;
  slides: Slide[];
}

export async function generateSlideDeck(req: {
  topic: string;
  angle?: string;
  /** Total slides including cover and CTA. Clamped 5–7. */
  slideCount?: number;
}): Promise<SlideDeck> {
  const total = Math.min(7, Math.max(5, req.slideCount ?? 6));
  const points = total - 2; // minus cover + cta

  const system = `You write carousel slide copy for ${FIRM.name}'s social channels (TikTok photo posts, Instagram carousels, Facebook, LinkedIn).

${PERSONA_BLOCK}

${COMPLIANCE_BLOCK}

═══ THE JOB ═══
A carousel is a swipeable argument: the cover earns the swipe, each middle slide lands ONE idea, the last slide invites action. Written copy only — the design is rendered separately, so never mention visuals, arrows or emoji.

═══ DECK SHAPE (exactly ${total} slides) ═══
1. COVER — kind "cover". A scroll-stopping headline, max 8 words. A truth, mistake or blunt statement — never the topic restated. Optional body of ONE short line (max 8 words) that sharpens it.
2–${total - 1}. POINTS — kind "point", ${points} slides. One idea each. Title max 6 words; body max 22 words of genuinely useful substance — slides are glanced at, not read. Sequence them so they build.
${total}. CTA — kind "cta". Title max 6 words. Body warmly invites a free call at ${FIRM.site} — no pitch, no pressure. Never salesy. Max 20 words.

═══ EMPHASIS ═══
In every cover and point title, mark the single word that carries the weight by wrapping it in *asterisks* (e.g. "Banks read *structure* first"). Exactly one marked word per title — it is rendered in gold.

═══ LANGUAGE ═══
- British English only.
- Plain, confident, specific. No hype words ("game-changer", "unlock", "secret").
- No hashtags, no emoji, no numbered "Step 1/2/3" prefixes in titles.

═══ OUTPUT ═══
Return ONLY this JSON:
{ "slides": [ { "kind": "cover|point|cta", "title": "...", "body": "..." } ] }`;

  const user = [
    `Topic: ${req.topic}`,
    req.angle ? `Angle / marketing goal: ${req.angle}` : "",
    "",
    `Write the ${total}-slide deck. Respect the word limits exactly — titles are rendered large and cannot wrap far.`,
  ]
    .filter(Boolean)
    .join("\n");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await chatWithRetry(
    openai,
    { max_completion_tokens: 3000, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    { label: "slideDeck", timeoutMs: 90_000 }
  );
  const raw = assertCompleted(res, "slideDeck");
  const parsed = extractJson<{ slides?: Slide[] }>(raw, "slideDeck");

  const slides = (parsed.slides ?? []).filter((s) => s?.title?.trim());
  if (slides.length < 3) throw new Error("slideDeck: model returned too few slides");
  return { topic: req.topic, slides };
}
