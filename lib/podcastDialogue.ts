/**
 * lib/podcastDialogue.ts
 * ─────────────────────────────────────────────────────────────
 * Turns an article into a natural two-voice podcast conversation:
 *   - host:   a curious interviewer who asks the questions a listener would
 *   - expert: a senior Aston VIP adviser who answers with specifics
 *
 * LENGTH-DRIVEN, SEGMENTED GENERATION
 * The selected length (15/30/45/60 min) determines how many segments the
 * episode is built from. We:
 *   1. Build an outline of N sub-topics from the blog post (N scales with length)
 *   2. Generate each segment's dialogue as its own small call (in parallel)
 *   3. Stitch the segments into one ordered conversation
 *
 * This replaces the old single-call approach, which asked one model call for
 * 100+ turns of JSON and unreliably truncated to ~2–3 minutes. Small per-segment
 * calls cannot truncate, so the final length tracks the selection.
 *
 * gpt-4o is used (not gpt-5.5) on purpose: each segment is a small, mechanical
 * conversational chunk where gpt-4o is fast and reliable, and 20 parallel
 * reasoning-model calls would be slow and costly.
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

export type PodcastLengthMins = 3 | 15 | 30 | 45 | 60;

// Segments per length × words per segment ≈ total words; at ~150 words per
// minute that lands close to the target duration. 3min is a cheap test length.
//   3min  ≈ 2×230  ≈ 460w  ≈ 3min    15min ≈ 6×440 ≈ 2,600w ≈ 17min
//   30min ≈ 10×450 ≈ 4,500w ≈ 30min  45min ≈ 15×450 ≈ 6,750w ≈ 45min
//   60min ≈ 20×450 ≈ 9,000w ≈ 60min
const LENGTH_CONFIG: Record<PodcastLengthMins, { segments: number; wordsPerSegment: number; sourceChars: number; minWords: number }> = {
  3:  { segments: 2,  wordsPerSegment: 230, sourceChars: 8000,  minWords: 350 },
  15: { segments: 6,  wordsPerSegment: 440, sourceChars: 16000, minWords: 1500 },
  30: { segments: 10, wordsPerSegment: 450, sourceChars: 26000, minWords: 3200 },
  45: { segments: 15, wordsPerSegment: 450, sourceChars: 36000, minWords: 5000 },
  60: { segments: 20, wordsPerSegment: 450, sourceChars: 48000, minWords: 6800 },
};

const SHOW_NAME = process.env.PODCAST_TITLE || "Aston VIP Insights";
const MODEL = "gpt-4o";
// Only add ElevenLabs audio tags ([laughs], [sighs]) when the podcast voice
// model is v3 (which renders them). On v2 they'd be read aloud literally.
const EMOTION_TAGS = (process.env.ELEVENLABS_PODCAST_MODEL || "eleven_v3").includes("v3");

// Shared voice/style guidance used by every segment so they sound consistent.
const STYLE = `You write podcast conversations for "${SHOW_NAME}" by Aston VIP — a high-end international corporate advisory firm (company formation, banking, tax structuring, licensing, residency across the UAE, UK, EU and offshore). The output is read aloud by text-to-speech, so it must sound like a REAL unscripted conversation between two people — not an article split into turns.

THE TWO SPEAKERS
- HOST — LIZ: warm, curious, quick. Asks the questions a smart business owner would actually ask. Reacts to what Stephan just said ("Oh interesting", "Wait, really?", "Right, so..."), pushes for specifics. Never lectures.
- EXPERT — STEPHAN: a senior Aston VIP adviser. Confident and friendly, not formal. Explains things the way you would to a client over coffee — plain English, quick asides, the odd "honestly" or "look". Backs claims with real specifics.
- They know each other and use first names naturally — but not in every line.

HOW TO MAKE IT SOUND HUMAN
- Write how people TALK: contractions everywhere ("it's", "you've", "they'll").
- Vary turn length: mix short host reactions with longer expert explanations.
- Natural connectives sparingly: "so", "look", "honestly", "the thing is", "here's the part people miss".
- The host reacts and asks FOLLOW-UPS based on the previous answer.
- Use commas, ellipses (…) and short sentences to shape delivery for TTS. Fragments are fine.
- Read-aloud friendly numbers: "around fifteen thousand dirhams", "about three to four weeks", "nine percent" — NOT "AED 15,000" or "9%". Spell out acronyms the first time ("DIFC — the Dubai International Financial Centre").
- EXPERT turns are 80–150 words (5–9 sentences) packed with real specifics. HOST turns are 5–40 words.

NEVER
- No formal connectors ("Furthermore", "Moreover", "In conclusion").
- No reading lists aloud ("First… Second…"). Weave points into the chat.
- No stage directions, sound effects, speaker labels or markdown. Spoken words only.
- British English, always write "license" (never "licence"). Never invent figures — stay grounded in the source.${EMOTION_TAGS ? `

EMOTION (audio tags — the voice model renders these as REAL non-verbal sounds)
- Occasionally add natural cues in square brackets so it feels human: [laughs], [chuckles], [sighs], [exhales], [clears throat].
- Use SPARINGLY — at most once every 5 or 6 turns, mostly on the host's light reactions or a warm laugh. Never stack them or use one every turn.
- Place the tag exactly where the sound happens, e.g. "[chuckles] Honestly, that's the part everyone gets wrong."
- Only these bracketed cues are allowed — no other stage directions.` : ""}`;

interface OutlinePlan {
  episodeTitle: string;
  subtopics: string[];
}

/** Step 1 — plan the episode: an ordered list of sub-topics scaled to length. */
async function generateOutline(
  openai: OpenAI, title: string, source: string, focusKeyword: string | undefined, segments: number
): Promise<OutlinePlan> {
  const user = `Plan a podcast episode based on this article.

ARTICLE TITLE: "${title}"
${focusKeyword ? `CORE TOPIC: ${focusKeyword}` : ""}

SOURCE MATERIAL:
${source}

Break the episode into EXACTLY ${segments} sub-topics, in the order they should be discussed. Each sub-topic is one distinct angle a smart business owner would want covered (e.g. requirements, real costs, jurisdiction choice, banking, tax, common mistakes, timelines, a real scenario). They must flow as a natural arc from opening to wrap-up, cover the article's substance, and not repeat each other.

Return ONE valid JSON object, no markdown:
{
  "episodeTitle": "short listener-facing title, max 70 chars, no colons",
  "subtopics": ["sub-topic 1 as a short phrase", "... exactly ${segments} items ..."]
}`;

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: STYLE }, { role: "user", content: user }],
  }, { signal: AbortSignal.timeout(60_000) });

  const raw = res.choices[0]?.message?.content?.trim() ?? "";
  const parsed = JSON.parse(raw) as Partial<OutlinePlan>;
  let subtopics = (parsed.subtopics ?? []).filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
  if (subtopics.length === 0) throw new Error("Podcast outline returned no sub-topics");
  // Pad/trim to the requested count so the episode length stays predictable.
  if (subtopics.length > segments) subtopics = subtopics.slice(0, segments);
  while (subtopics.length < segments) subtopics.push(subtopics[subtopics.length % subtopics.length] || title);
  return { episodeTitle: (parsed.episodeTitle ?? title).trim().slice(0, 80), subtopics };
}

/** Step 2 — generate the dialogue for a single sub-topic segment. */
async function generateSegment(
  openai: OpenAI,
  ctx: { title: string; focusKeyword?: string; source: string; allSubtopics: string[]; index: number; total: number; wordsTarget: number }
): Promise<DialogueTurn[]> {
  const { title, focusKeyword, source, allSubtopics, index, total, wordsTarget } = ctx;
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const subtopic = allSubtopics[index];

  const position = isFirst
    ? `This is the OPENING segment. Start with LIZ welcoming listeners — warm and natural: "Welcome back to ${SHOW_NAME}, I'm Liz", say in one engaging line what today's episode is about, and introduce her guest ("…and I'm joined, as always, by Stephan, one of our senior advisers here at Aston VIP"). Then STEPHAN gives a brief friendly hello (one line). Then move into the sub-topic below.`
    : isLast
    ? `This is the FINAL segment. Cover the sub-topic below, then LIZ wraps the whole episode: a quick takeaway, thank Stephan by name, then the exact call to action "to speak with the Aston VIP team, visit aston dot a-e".`
    : `This is a MIDDLE segment. Open with LIZ making a natural transition into the sub-topic below (do NOT greet or re-introduce anyone — the episode is already underway), then dig into it.`;

  const user = `You are writing ONE segment of an ongoing podcast episode for "${SHOW_NAME}".

EPISODE TOPIC: "${title}"${focusKeyword ? `\nCORE TOPIC: ${focusKeyword}` : ""}

THE FULL EPISODE ARC (for context — do NOT cover the others, only your segment):
${allSubtopics.map((s, i) => `${i + 1}. ${s}${i === index ? "  ← YOUR SEGMENT" : ""}`).join("\n")}

YOUR SEGMENT (#${index + 1} of ${total}) — cover ONLY this sub-topic: "${subtopic}"

${position}

SOURCE MATERIAL (draw real specifics from here):
${source}

LENGTH — write ${Math.round(wordsTarget * 0.9)} to ${Math.round(wordsTarget * 1.15)} words of dialogue for THIS segment across ${wordsTarget < 300 ? "2 to 3" : "4 to 6"} back-and-forth exchanges. Expert (Stephan) turns carry the substance (up to ~150 words); host (Liz) turns stay short. This is mandatory — do not write a short segment.

Return ONE valid JSON object, no markdown:
{ "turns": [ { "speaker": "host", "text": "..." }, { "speaker": "expert", "text": "..." } ] }`;

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.9,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: STYLE }, { role: "user", content: user }],
  }, { signal: AbortSignal.timeout(90_000) });

  const raw = res.choices[0]?.message?.content?.trim() ?? "";
  const parsed = JSON.parse(raw) as { turns?: DialogueTurn[] };
  return (parsed.turns ?? [])
    .filter((t): t is DialogueTurn =>
      !!t && (t.speaker === "host" || t.speaker === "expert") && typeof t.text === "string" && t.text.trim().length > 0)
    .map((t) => ({ speaker: t.speaker, text: t.text.trim() }));
}

export async function generatePodcastDialogue(
  title: string,
  sourceText: string,
  focusKeyword?: string,
  length: PodcastLengthMins = 30
): Promise<PodcastDialogue> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const cfg = LENGTH_CONFIG[length];
  const source = sourceText.slice(0, cfg.sourceChars);

  // 1. Plan the episode arc (N sub-topics scaled to the selected length).
  const outline = await generateOutline(openai, title, source, focusKeyword, cfg.segments);
  console.log(`[podcastDialogue] ${length}-min episode → ${outline.subtopics.length} segments planned`);

  // 2. Generate each segment in bounded parallel (keeps long episodes fast and
  //    avoids the truncation that broke the old single-call approach).
  const CONCURRENCY = 5;
  const segmentTurns: DialogueTurn[][] = new Array(outline.subtopics.length).fill(null).map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < outline.subtopics.length) {
      const i = next++;
      try {
        segmentTurns[i] = await generateSegment(openai, {
          title, focusKeyword, source, allSubtopics: outline.subtopics, index: i, total: outline.subtopics.length,
          wordsTarget: cfg.wordsPerSegment,
        });
      } catch (err) {
        console.warn(`[podcastDialogue] segment ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        segmentTurns[i] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, outline.subtopics.length) }, worker));

  // 3. Stitch in order.
  const turns = segmentTurns.flat();
  const totalWords = turns.reduce((sum, t) => sum + t.text.split(/\s+/).filter(Boolean).length, 0);
  console.log(`[podcastDialogue] generated ${turns.length} turns, ${totalWords} words (~${Math.round(totalWords / 150)} min)`);

  if (turns.length === 0) throw new Error("Podcast dialogue generation produced no turns");
  if (totalWords < cfg.minWords) {
    console.warn(`[podcastDialogue] episode is shorter than target (${totalWords} < ${cfg.minWords} words) — some segments may have failed`);
  }

  return { episodeTitle: outline.episodeTitle, turns };
}
