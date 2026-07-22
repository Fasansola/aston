/**
 * lib/social/slideDeck.ts
 * Writes the COPY for a text-on-image carousel and generates the intro image.
 * The images themselves are rendered programmatically (slideRender.ts) — the
 * model never draws text, it only writes it, so nothing is ever misspelled.
 *
 * Deck shape: an image intro slide (GPT Image 2 photo + a navy title banner),
 * N one-idea point slides, and a fixed contact slide. The model writes the
 * intro hook, an image brief for the photo, and the point copy; the contact
 * slide is fixed (ported from the video generator's end screen).
 *
 * Per the account's model constraints, gpt-5.x is called WITHOUT a temperature.
 */

import OpenAI from "openai";
import { chatWithRetry, assertCompleted, extractJson } from "@/lib/llm";
import { generateImage } from "@/lib/openai";
import { PERSONA_BLOCK, COMPLIANCE_BLOCK, FIRM } from "@/lib/social/persona";

export interface Slide {
  kind: "point";
  /** Big display headline, ≤ 6 words. Rendered in caps with one gold word. */
  title: string;
  /** Supporting sentence(s), ≤ 22 words. */
  body?: string;
}

export interface SlideDeck {
  topic: string;
  /** Intro slide headline (the hook). May contain one *asterisked* emphasis word. */
  hook: string;
  /** A text-free visual scene for the intro image (GPT Image 2). */
  imageBrief: string;
  /** The middle point slides. */
  slides: Slide[];
}

export async function generateSlideDeck(req: {
  topic: string;
  angle?: string;
  /** Number of CONTENT (point) slides. The intro + contact bookends are added on top. Clamped 4–8. */
  slideCount?: number;
}): Promise<SlideDeck> {
  const points = Math.min(8, Math.max(4, req.slideCount ?? 5));

  const system = `You write carousel slide copy for ${FIRM.name}'s social channels (TikTok photo posts, Instagram carousels, Facebook, LinkedIn).

${PERSONA_BLOCK}

${COMPLIANCE_BLOCK}

═══ THE JOB ═══
A carousel is a swipeable argument. The deck opens on an IMAGE slide (a photo with a title banner), then ${points} point slides each land ONE idea, then a fixed contact slide closes it. You write: the intro hook, a brief for the intro photo, and the ${points} point slides. You do NOT write the contact slide.

═══ WHAT TO RETURN ═══
- hook: the intro slide headline. Max 8 words. A scroll-stopping truth, mistake or blunt statement — never the topic restated. Mark the single strongest word with *asterisks* (rendered gold).
- imageBrief: a short description of a professional, editorial PHOTO for the intro background — relevant to the topic, corporate/business world, Dubai or London setting where it fits. It MUST contain no text, no words, no logos, no charts. Describe scene, subject, lighting, mood only.
- slides: ${points} point slides. Each: title (max 6 words, mark one word with *asterisks*) + body (max 22 words of genuinely useful substance — slides are glanced at, not read). Sequence them so they build.

═══ LANGUAGE ═══
- British English only.
- Plain, confident, specific. No hype words ("game-changer", "unlock", "secret").
- No hashtags, no emoji, no numbered "Step 1/2/3" prefixes in titles.

═══ OUTPUT ═══
Return ONLY this JSON:
{ "hook": "...", "imageBrief": "...", "slides": [ { "title": "...", "body": "..." } ] }`;

  const user = [
    `Topic: ${req.topic}`,
    req.angle ? `Angle / marketing goal: ${req.angle}` : "",
    "",
    `Write the hook, the intro image brief, and the ${points} point slides. Respect the word limits exactly — titles are rendered large and cannot wrap far.`,
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
  const parsed = extractJson<{ hook?: string; imageBrief?: string; slides?: Array<{ title?: string; body?: string }> }>(
    raw,
    "slideDeck"
  );

  const slides: Slide[] = (parsed.slides ?? [])
    .filter((s) => s?.title?.trim())
    .map((s) => ({ kind: "point" as const, title: s.title!.trim(), body: s.body?.trim() }));
  if (slides.length < 3) throw new Error("slideDeck: model returned too few slides");
  if (!parsed.hook?.trim()) throw new Error("slideDeck: model returned no hook");

  return {
    topic: req.topic,
    hook: parsed.hook.trim(),
    imageBrief: parsed.imageBrief?.trim() || `A professional, editorial photograph representing ${req.topic}. Corporate business setting, no text.`,
    slides,
  };
}

/**
 * Generate the intro background photo with GPT Image 2. Text is overlaid later,
 * so the prompt hard-forbids any text in the image.
 */
export async function generateIntroImage(imageBrief: string): Promise<Buffer> {
  const prompt = [
    imageBrief,
    "Editorial, cinematic corporate photography. Muted, sophisticated palette with deep navy and subtle warm tones. Shallow depth of field, natural light, premium and understated.",
    "ABSOLUTELY NO text, no words, no letters, no numbers, no logos, no watermarks, no charts, no graphs, no captions anywhere in the image.",
  ].join(" ");
  return generateImage(prompt, "gpt-image-2");
}
