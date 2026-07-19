/**
 * lib/social/reelScript.ts
 * Writes short vertical-reel scripts (roughly 20–60 seconds) in the Aston VIP
 * presenter's voice, for the social studio's HeyGen avatar pipeline.
 *
 * Deliberately separate from lib/heygen.ts's long-form generator: a reel is a
 * different shape entirely — one idea, a hook that lands in two seconds, and a
 * single call to action. The long-form script is 3–4 minutes across 7 segments.
 *
 * Output is structured so the render pipeline can use it directly: `hook` and
 * `onScreenTitle` drive the muted-viewer overlay, `script` drives ElevenLabs.
 * Per the account's model constraints, gpt-5.x is called WITHOUT a temperature.
 */

import OpenAI from "openai";
import { chatWithRetry, assertCompleted, extractJson } from "@/lib/llm";
import { PERSONA_BLOCK, COMPLIANCE_BLOCK, FIRM, PRESENTER } from "@/lib/social/persona";

/** Natural ElevenLabs narration pace, words per minute. Used to size the script. */
const WORDS_PER_MINUTE = 150;

export interface ReelScriptRequest {
  /** What the reel is about, e.g. "why banks reject new companies". */
  topic: string;
  /** Optional sharper angle or the marketing goal, e.g. "promote the Golden Visa service". */
  angle?: string;
  /** Target spoken length. Reels live between 20 and 60 seconds. */
  durationSeconds?: number;
  /** ISO code; defaults to English (British). */
  language?: string;
}

export interface ReelScript {
  /** The opening spoken line — doubles as the first on-screen caption. */
  hook: string;
  /** Full spoken script, one sentence per line with blank lines between. */
  script: string;
  /** Short overlay title for muted viewers (max ~48 chars). */
  onScreenTitle: string;
  /** The closing call-to-action line. */
  cta: string;
  wordCount: number;
  estimatedSeconds: number;
  topic: string;
}

function targetWords(seconds: number): { min: number; max: number } {
  const mid = Math.round((seconds / 60) * WORDS_PER_MINUTE);
  return { min: Math.max(40, mid - 10), max: mid + 10 };
}

export async function generateReelScript(req: ReelScriptRequest): Promise<ReelScript> {
  const duration = Math.min(60, Math.max(20, req.durationSeconds ?? 40));
  const { min, max } = targetWords(duration);

  const langNote =
    req.language && req.language !== "en"
      ? `Write the script in ${req.language}.`
      : "British English only. Never American spellings.";

  const system = `You write short vertical video reel scripts for ${PRESENTER.name}, ${PRESENTER.role}. These reels run on TikTok, Instagram Reels, YouTube Shorts and LinkedIn.

${PERSONA_BLOCK}

${COMPLIANCE_BLOCK}

═══ THE JOB ═══
A reel is ONE idea. Not a summary, not a list. One sharp insight that makes a business owner stop scrolling and think "that's me".
It must both MARKET ${FIRM.name} and genuinely teach something. If it only sells, it fails. If it only teaches, it fails.

═══ LENGTH (STRICT) ═══
The spoken script must be between ${min} and ${max} words. That is about ${duration} seconds at natural speaking pace. Count your words. Going over ruins the reel.

═══ STRUCTURE ═══
1. HOOK (first 2 seconds) — one arresting line. A truth, a mistake, or a blunt statement. NEVER open with the topic name, a greeting, or "in this video". This line is also shown as on-screen text, so it must make sense silently.
2. TENSION — name the real pain in one or two lines. Personal. "I've seen this."
3. REVEAL — the thing most people don't know. This is the value. Be specific and useful.
4. CTA — ${PRESENTER.name} warmly invites a free call at ${FIRM.site}. Never pushy. No hard sell.

═══ FORMATTING (CRITICAL) ═══
Every sentence or fragment goes on its OWN line, with a blank line between each one. Short lines. Always. No paragraphs.

Example of the required rhythm:

"Most businesses don't fail because of a bad product.

They fail because they can't get a bank account.

And I've seen this happen. More times than I can count.

The problem isn't the business.

It's the STRUCTURE."

═══ LANGUAGE RULES ═══
- ${langNote}
- Contractions always: "it's", "you're", "I've", "don't", "that's".
- Fragments are good. "That's the mistake." "Day one. Not day thirty."
- Ellipses for natural pauses.
- ALL CAPS on 1–2 key words in the whole script for spoken emphasis. Not more.
- Never: "In today's video", "Welcome back", "In conclusion", "To summarise", "Hey guys".
- No stage directions, no [pause], no markdown, no bullet points, no emoji, no hashtags. Only the spoken words.

═══ OUTPUT ═══
Return ONLY this JSON object:
{
  "hook": "the opening spoken line, repeated exactly as it appears at the start of the script",
  "onScreenTitle": "a punchy overlay title, max 48 characters, no full stop",
  "script": "the full spoken script, every sentence on its own line, blank line between each",
  "cta": "the closing call-to-action line, repeated exactly as it appears at the end of the script"
}`;

  const user = [
    `Topic: ${req.topic}`,
    req.angle ? `Angle / marketing goal: ${req.angle}` : "",
    "",
    `Write one reel script of ${min}–${max} words (~${duration} seconds). Hook first. One idea only. End with the free-call invitation.`,
  ]
    .filter(Boolean)
    .join("\n");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await chatWithRetry(
    openai,
    {
      max_completion_tokens: 3000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    { label: "reelScript", timeoutMs: 90_000 }
  );

  const raw = assertCompleted(res, "reelScript");
  const parsed = extractJson<{ hook?: string; onScreenTitle?: string; script?: string; cta?: string }>(
    raw,
    "reelScript"
  );

  const script = (parsed.script ?? "").trim();
  if (!script) throw new Error("reelScript: model returned an empty script");

  const wordCount = script.split(/\s+/).filter(Boolean).length;

  return {
    hook: (parsed.hook ?? script.split("\n").find((l) => l.trim())?.trim() ?? "").trim(),
    script,
    onScreenTitle: (parsed.onScreenTitle ?? "").trim().slice(0, 48),
    cta: (parsed.cta ?? "").trim(),
    wordCount,
    estimatedSeconds: Math.round((wordCount / WORDS_PER_MINUTE) * 60),
    topic: req.topic,
  };
}
