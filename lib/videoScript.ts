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
  imagePrompt: string;
}

export interface TimedVideoSegment extends RawVideoSegment {
  durationSeconds: number;
}

/** Words per minute for Kokoro TTS narration */
const TTS_WPM = 130;

export function estimateDuration(text: string): number {
  const words = text.trim().split(/\s+/).length;
  // Add 1.5s buffer per segment for natural pauses
  return Math.max(18, Math.round((words / TTS_WPM) * 60) + 2);
}

/**
 * Calls GPT-4o-mini to divide the full article script into 7 video scenes.
 * Returns segments with narration text, display text, and image prompts.
 */
export async function segmentVideoScript(
  title: string,
  scriptFields: {
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

  const fullScript = articleToAudioScript(title, scriptFields);
  const wordCount  = fullScript.trim().split(/\s+/).length;
  console.log(`[videoScript] Full script: ${wordCount} words`);

  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_completion_tokens: 5000,
    messages: [
      {
        role: "system",
        content: `You divide article scripts into exactly 7 scenes for professional narrated slideshow videos.

SCENE RULES:
- narration: 90–110 words taken verbatim from the script — this is read aloud by TTS
- displayText: the single most important sentence from the narration (max 40 words) — shown on screen
- sectionTitle: 2–4 words naming this scene's topic (e.g. "Introduction", "Key Requirements", "Banking Setup")
- imagePrompt: 2–3 sentences describing a cinematic background scene

IMAGE PROMPT RULES — strict:
- ZERO people, faces, hands, or silhouettes
- ZERO text, signs, logos, or readable words
- Subject: architecture, city skylines, modern interiors, documents on a desk, technology hardware, abstract light
- Include lighting mood and camera movement (e.g. "slow aerial drift", "gentle dolly forward")
- Professional corporate aesthetic, 16:9`,
      },
      {
        role: "user",
        content: `Article title: "${title}"

Full script (${wordCount} words):
${fullScript}

Divide this into exactly 7 scenes. Use the actual script text — do not invent content.
Return a JSON array only — no markdown, no code fences, no explanation:

[
  {
    "sectionTitle": "Introduction",
    "narration": "...",
    "displayText": "...",
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

  // Attach duration estimate based on narration word count
  return segments.map((seg) => ({
    ...seg,
    durationSeconds: estimateDuration(seg.narration),
  }));
}
