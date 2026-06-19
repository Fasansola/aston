/**
 * lib/videoScript.ts
 * ─────────────────────────────────────────────────────────────
 * Segments an article script into timed video scenes.
 *
 * Each scene has:
 *   - sectionTitle: 2–4 word label shown as a title card
 *   - narration:    full text read by TTS (~100 words)
 *   - displayText:  1–2 punchy sentences shown on screen (~35 words)
 *   - imagePrompt:  cinematic background image prompt
 *
 * TTS is generated from the full narration. On-screen text uses
 * the shorter displayText so the frame isn't overwhelmed.
 */

import OpenAI from "openai";
import { articleToAudioScript } from "./replicate";

export interface RawVideoSegment {
  sectionTitle: string;
  narration: string;
  displayText: string;
  bullets: string[];
  imagePrompt: string;
}

export interface TimedVideoSegment extends RawVideoSegment {
  durationSeconds: number;
  wordCount: number;  // kept so durations can be recalibrated against real audio length
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Recalibrates segment durations so they sum exactly to actualAudioSeconds.
 * Uses each segment's word count as the proportional weight — the more words
 * a segment has, the longer its slice of the audio timeline.
 *
 * This is the key sync fix: instead of guessing each segment's duration from
 * word count alone, we measure the real audio and divide it proportionally.
 */
export function calibrateSegmentDurations(
  segments: TimedVideoSegment[],
  actualAudioSeconds: number
): TimedVideoSegment[] {
  const totalWords = segments.reduce((s, seg) => s + seg.wordCount, 0);
  if (totalWords === 0) return segments;

  return segments.map((seg) => ({
    ...seg,
    durationSeconds: Math.max(8, (seg.wordCount / totalWords) * actualAudioSeconds),
  }));
}

/**
 * Calls GPT-4o-mini to divide the full article script into 7 video scenes.
 * Returns segments with narration text, display text, and image prompts.
 *
 * If no content fields are provided (standalone mode), GPT generates a full
 * educational script from scratch based on the title alone.
 */
export async function segmentVideoScript(
  title: string,
  scriptFields?: {
    main_content?: string;
    more_content_1?: string;
    more_content_2?: string;
    more_content_3?: string;
    more_content_4?: string;
    more_content_5?: string;
    more_content_6?: string;
    final_points?: string;
  }
): Promise<TimedVideoSegment[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const rawScript  = scriptFields ? articleToAudioScript(title, scriptFields) : "";
  const wordCount  = rawScript.trim().split(/\s+/).filter(Boolean).length;
  const hasContent = wordCount > 150;

  // When no article content is available, ask GPT to write the full script
  const fullScript = hasContent ? rawScript : "";
  console.log(`[videoScript] ${hasContent ? `${wordCount} words from article` : "standalone — GPT will write script"}`);

  // gpt-4o (not gpt-5.5) on purpose: scene segmentation is a fast, mechanical
  // summarisation task that runs inside the shared 300s video pipeline alongside
  // 7 sequential image generations. gpt-5.5's reasoning latency overran the 45s
  // script timeout ("Request was aborted") and starved the rest of the budget.
  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: `You are a video script writer. Given a long blog article, you produce a tight 3–4 minute video script divided into exactly 7 scenes. The video must stand alone as a summary — it should not read like an excerpt of the article.

TARGET LENGTH: 3–4 minutes total. At ~130 words per minute that means 60–70 words of narration per scene (420–490 words total). Do not exceed 70 words per scene.

SCENE RULES:
- narration: 60–70 words written fresh as a spoken video script — clear, punchy, conversational. Summarise the key point of this section; do NOT copy verbatim from the article. Written to be read aloud by a professional voiceover.
- displayText: the single most important sentence from the narration (max 30 words) — shown on screen
- bullets: exactly 3 short checklist items (6–10 words each) — distil the key actions, steps, or facts from this scene. Written as punchy imperatives or facts (e.g. "Choose a free zone matching your activity", "Minimum share capital from AED 1,000")
- sectionTitle: 2–4 words naming this scene's topic (e.g. "Introduction", "Key Requirements", "Banking Setup")
- imagePrompt: 2–3 sentences written as a PHOTOGRAPHY BRIEF for a real photograph that illustrates this scene

IMAGE PROMPT RULES — write as if briefing a professional photographer:
- Start with "A photograph of…" — this forces the model into photorealistic mode rather than illustration mode
- Describe EXACTLY what is happening: specific people (their role, attire, action), specific objects, specific real-world location
- Ground it in the narration: UAE banking scene → show a banker and client at a desk reviewing account documents; company formation → show someone signing incorporation papers; tax scene → show a tax adviser with spreadsheets and a laptop
- Include camera and lens details — this is the single most important trick for realism: e.g. "shot on Sony A7R V, 85mm f/1.8 lens, shallow depth of field" or "shot on Canon EOS R5, 50mm f/2.0"
- Include specific, natural lighting: "afternoon light from floor-to-ceiling windows", "overhead office LED lighting", "warm desk lamp casting shadows"
- Name the real location type: "a glass-walled boardroom in a Dubai free zone tower", "a private banking suite in a Zurich financial centre", "a modern co-working space in DIFC"
- Keep the main subject centred — the image is cropped on the left and right edges when displayed, so never place important content near the edges
- NEVER use these words — they produce AI-looking results: cinematic, dramatic, glowing, ethereal, stunning, vibrant, majestic, epic, surreal, fantasy, artistic, render, 3D
- GOOD example: "A photograph of a male legal consultant in a navy suit reviewing UAE company formation documents with a client across a glass desk in a sunlit DIFC office tower, floor-to-ceiling windows with soft afternoon light, shot on Sony A7R V 85mm f/1.8, shallow depth of field, warm neutral tones"
- BAD example: "Professional business meeting in a modern office with dramatic cinematic lighting and vibrant colours" — too generic, no photography language, will look AI-generated`,
      },
      {
        role: "user",
        content: hasContent
          ? `Article title: "${title}"

Full article (${wordCount} words):
${fullScript}

Write a tight 3–4 minute video script that summarises this article across exactly 7 scenes.
Each narration must be 60–70 words — written fresh for video, NOT copied verbatim from the article.
Cover the article's key points. Make each scene self-contained and engaging when spoken aloud.
Return a JSON array only — no markdown, no code fences, no explanation:

[
  {
    "sectionTitle": "Introduction",
    "narration": "...",
    "displayText": "...",
    "bullets": ["...", "...", "..."],
    "imagePrompt": "..."
  }
]`
          : `Topic / title: "${title}"

No article text is provided. Write a complete 7-scene video script on this topic from scratch.
Target: 3–4 minutes total — 60–70 words of narration per scene.
Target audience: business owners and entrepreneurs interested in UAE and international corporate advisory.
Write with authority — real jurisdiction names, regulator names, realistic fee ranges, practical advice.
Each scene must cover a distinct aspect of the topic and flow naturally when spoken aloud.

Return a JSON array only — no markdown, no code fences:

[
  {
    "sectionTitle": "Introduction",
    "narration": "...",
    "displayText": "...",
    "bullets": ["...", "...", "..."],
    "imagePrompt": "..."
  }
]`,
      },
    ],
  }, { signal: AbortSignal.timeout(45_000) });

  const raw = choices[0].message.content?.trim() ?? "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error(`Script segmentation returned no JSON. Raw: ${raw.slice(0, 200)}`);
  }

  const segments = JSON.parse(match[0]) as RawVideoSegment[];

  // Attach word counts — durations are placeholders until recalibrated
  // against the real audio length in generate-video/route.ts
  return segments.map((seg) => ({
    ...seg,
    wordCount: countWords(seg.narration),
    durationSeconds: 0, // recalibrated after audio generation
  }));
}
