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

export type PodcastLengthMins = 15 | 30 | 45 | 60;

const LENGTH_CONFIG: Record<PodcastLengthMins, { rule: string; maxTokens: number; sourceChars: number }> = {
  15: { rule: "Length: ~15 minutes when spoken — roughly 1,800–2,200 words total. 24–32 turns.",   maxTokens: 5000,  sourceChars: 12000 },
  30: { rule: "Length: ~30 minutes when spoken — roughly 3,800–4,500 words total. 50–65 turns.",   maxTokens: 10000, sourceChars: 22000 },
  45: { rule: "Length: ~45 minutes when spoken — roughly 5,500–6,500 words total. 75–95 turns.",   maxTokens: 14000, sourceChars: 32000 },
  60: { rule: "Length: ~60 minutes when spoken — roughly 7,500–9,000 words total. 100–130 turns.", maxTokens: 16000, sourceChars: 45000 },
};

const SHOW_NAME = process.env.PODCAST_TITLE || "Aston VIP Insights";

export async function generatePodcastDialogue(
  title: string,
  sourceText: string,
  focusKeyword?: string,
  length: PodcastLengthMins = 30
): Promise<PodcastDialogue> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const cfg = LENGTH_CONFIG[length];
  const lengthRule = cfg.rule;

  const system = `You write podcast conversations for "${SHOW_NAME}" by Aston VIP — a high-end international corporate advisory firm (company formation, banking, tax structuring, licensing, residency across the UAE, UK, EU and offshore). The output is read aloud by text-to-speech, so it must sound like a REAL unscripted conversation between two people — not an article split into turns.

THE TWO SPEAKERS
- HOST — LIZ: warm, curious, quick. Asks the questions a smart business owner would actually ask. Reacts to what Stephan just said ("Oh interesting", "Wait, really?", "Right, so..."), pushes for specifics, sometimes thinks out loud. Never lectures.
- EXPERT — STEPHAN: a senior Aston VIP adviser. Confident and friendly, not formal. Explains things the way you would to a client over coffee — plain English, quick asides, the odd "honestly" or "look". Backs claims with real specifics.
- They know each other and use first names naturally ("So Stephan…", "Good question, Liz") — but not in every single line.

HOW TO MAKE IT SOUND HUMAN (this is the whole point)
- Write how people TALK, not how they write. Contractions everywhere ("it's", "you've", "they'll", "I'd").
- Vary turn length a lot: some turns are a 2-3 word reaction ("Right.", "That's the trap.", "Makes sense."), others run a few sentences. Never make every turn the same length.
- Use natural connective speech sparingly: "so", "look", "honestly", "the thing is", "here's the part people miss", "yeah, exactly". Don't overdo it — once every few turns.
- The host genuinely reacts and asks FOLLOW-UPS based on the previous answer, not a fixed list of questions. Real curiosity.
- Use punctuation to shape delivery for the TTS: commas for natural pauses, ellipses (…) for a trailing or thinking beat, an em-style pause with a comma, and dashes for a quick self-correction. Short sentences. Fragments are fine.
- Occasionally drop a tiny concrete moment: "I had a client last year who…", "we see this constantly".
- Read-aloud friendly numbers: write figures the way they're spoken — "around fifteen thousand dirhams", "about three to four weeks", "nine percent" — NOT "AED 15,000" or "9%". Spell out acronyms the first time if they'd be unclear ("DIFC — the Dubai International Financial Centre").

NEVER DO THIS (it kills the realism)
- No formal/essay connectors: "Furthermore", "Moreover", "Additionally", "In conclusion", "It is important to note".
- No reading lists aloud ("First… Second… Third…"). Weave points into the chat instead.
- No long monologues. If the expert goes more than ~4 sentences, the host should cut in.
- No stage directions, sound effects, speaker labels, or markdown. Spoken words only.

RULES
- British English. Always write "license" (never "licence").
- Never invent figures — keep facts realistic and grounded in the source material.

EXAMPLE of the target feel (style only, not the topic):
LIZ: "Okay so everyone says 'just set up in a free zone' — is it really that simple, Stephan?"
STEPHAN: "Honestly? No. I mean it can be, but the bit people skip is the banking."
LIZ: "The banking?"
STEPHAN: "Yeah. You get the license in a week, feel great… and then the account takes two months because nobody prepped the compliance file."`;

  const user = `Create a podcast conversation based on this article.

ARTICLE TITLE: "${title}"
${focusKeyword ? `CORE TOPIC: ${focusKeyword}` : ""}

SOURCE MATERIAL:
${sourceText.slice(0, cfg.sourceChars)}

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
- The FIRST turn is LIZ welcoming listeners — warm and natural, not corporate: something like "Welcome back to ${SHOW_NAME}, I'm Liz", say what today's episode is about in one engaging line, and introduce her guest ("…and I'm joined, as always, by Stephan, one of our senior advisers here at Aston VIP"). ~3 sentences.
- The SECOND turn is STEPHAN with a brief, friendly hello (one line, e.g. "Great to be here, Liz") before Liz asks her first real question.
- The LAST turn is LIZ wrapping up: a quick takeaway, thank Stephan by name, then the call to action "to speak with the Aston VIP team, visit aston dot a-e". ~2-3 sentences.
- Between intro and outro: a genuine, flowing conversation covering the key points — requirements, costs, jurisdictions, risks, what businesses get wrong. Cover them through back-and-forth, not a checklist.
- Start with the HOST. Mostly alternate, but the host can interject a short reaction before the expert continues. The expert carries the substance; the host stays curious and reactive.
- Vary turn length: mix 2-5 word reactions with longer explanations. No single turn longer than ~80 words.`;

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.9,
    max_tokens: cfg.maxTokens,
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
