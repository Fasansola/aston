/**
 * lib/podcastDialogue.ts
 * ─────────────────────────────────────────────────────────────
 * Turns an article into a natural two-voice podcast conversation:
 *   - host:   a curious interviewer who asks the questions a listener would
 *   - expert: a senior Aston VIP adviser who answers with specifics
 *
 * Output is a structured list of turns plus a fixed AI-spoken intro and outro,
 * sized for an 8–12 minute episode. The audio layer (lib/podcastAudio.ts) voices
 * each turn and stitches in the music sting.
 */

import OpenAI from "openai";

export type Speaker = "host" | "expert";

export interface DialogueTurn {
  speaker: Speaker;
  text: string;
}

export interface PodcastDialogue {
  episodeTitle: string;     // short, listener-facing episode title
  turns: DialogueTurn[];    // intro + body + outro, in order
}

const SHOW_NAME = process.env.PODCAST_TITLE || "Aston VIP Insights";

export async function generatePodcastDialogue(
  title: string,
  sourceText: string,
  focusKeyword?: string,
  length: "short" | "medium" = "medium"
): Promise<PodcastDialogue> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const lengthRule = length === "short"
    ? "Length: 3–4 minutes when spoken — roughly 600–900 words total. 8–12 turns."
    : "Length: 8–12 minutes when spoken — roughly 1400–1900 words total. 14–24 turns.";

  const system = `You write natural, engaging two-person podcast conversations for "${SHOW_NAME}", a show by Aston VIP — a high-end international corporate advisory firm (company formation, banking, tax structuring, licensing, residency across the UAE, UK, EU and offshore).

The two speakers:
- HOST: a sharp, curious interviewer. Asks the questions a smart business owner would ask. Keeps things moving, occasionally summarises, reacts naturally ("Right", "That's the part people miss"). Does NOT lecture.
- EXPERT: a senior Aston VIP adviser. Warm but authoritative. Answers with specifics — real jurisdictions, regulators, fee ranges, timelines, common mistakes. Explains jargon in plain English.

STYLE:
- Sounds like two people actually talking, not an article read aloud. Contractions, short reactions, natural back-and-forth.
- British English. Always write "license" (never "licence").
- No stage directions, no sound-effect notes, no markdown. Just spoken words.
- Never invent fake figures; keep facts realistic and grounded in the source.
- The host asks; the expert answers. Alternate naturally — the expert can give a couple of sentences, the host can follow up.`;

  const user = `Create a podcast conversation based on this article.

ARTICLE TITLE: "${title}"
${focusKeyword ? `CORE TOPIC: ${focusKeyword}` : ""}

SOURCE MATERIAL:
${sourceText.slice(0, 9000)}

Return a single valid JSON object. No markdown, no code fences:

{
  "episodeTitle": "short listener-facing episode title (max 70 chars, no colons)",
  "turns": [
    { "speaker": "host", "text": "..." },
    { "speaker": "expert", "text": "..." }
  ]
}

RULES:
- ${lengthRule}
- The FIRST turn must be the HOST giving a spoken intro: welcome to ${SHOW_NAME}, name today's topic, and a one-line hook. Keep it ~2 sentences.
- The LAST turn must be the HOST giving a spoken outro: a quick wrap-up plus "to speak with the Aston VIP team, visit aston dot a-e". Keep it ~2 sentences.
- Between intro and outro: a genuine conversation that covers the article's key points — requirements, costs, jurisdictions, risks, and what businesses get wrong.
- Start with HOST, then alternate host/expert. The expert carries the substance; the host drives with questions and reactions.
- No single turn longer than ~120 words.`;

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.8,
    max_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }, { signal: AbortSignal.timeout(90_000) });

  const raw = choices[0]?.message?.content?.trim() ?? "";
  let parsed: Partial<PodcastDialogue>;
  try {
    parsed = JSON.parse(raw) as Partial<PodcastDialogue>;
  } catch {
    throw new Error(`Podcast dialogue returned invalid JSON. Raw: ${raw.slice(0, 200)}`);
  }

  const turns = (parsed.turns ?? [])
    .filter((t): t is DialogueTurn =>
      !!t && (t.speaker === "host" || t.speaker === "expert") && typeof t.text === "string" && t.text.trim().length > 0)
    .map((t) => ({ speaker: t.speaker, text: t.text.trim() }));

  if (turns.length < 4) {
    throw new Error(`Podcast dialogue too short (${turns.length} turns)`);
  }

  return {
    episodeTitle: (parsed.episodeTitle ?? title).trim().slice(0, 80),
    turns,
  };
}
