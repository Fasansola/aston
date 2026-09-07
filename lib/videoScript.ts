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
import { extractJson, chatWithRetry, assertCompleted, MEDIA_MODEL } from "./llm";
import { assessPromptDiversity, formatSceneBriefs, formatRecentConcepts, type RecentImageConcept } from "./imageBrief";

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
  const systemPrompt = `You are a video script writer. Given a long blog article, you produce a tight 3–4 minute video script divided into exactly 7 scenes. The video must stand alone as a summary — it should not read like an excerpt of the article.

TARGET LENGTH: 3–4 minutes total. At ~130 words per minute that means 60–70 words of narration per scene (420–490 words total). Do not exceed 70 words per scene.

SCENE RULES:
- narration: 60–70 words written fresh as a spoken video script — clear, punchy, conversational. Summarise the key point of this section; do NOT copy verbatim from the article. Written to be read aloud by a professional voiceover.
- displayText: the single most important sentence from the narration (max 30 words) — shown on screen
- bullets: exactly 3 short checklist items (6–10 words each) — distil the key actions, steps, or facts from this scene. Written as punchy imperatives or facts (e.g. "Choose a free zone matching your activity", "Minimum share capital from AED 1,000")
- sectionTitle: 2–4 words naming this scene's topic (e.g. "Introduction", "Key Requirements", "Banking Setup")
- imagePrompt: a first-draft photography brief (40–60 words) for a real photograph that illustrates THIS scene's narration. A dedicated art-direction pass rewrites these, so keep it honest and specific: one clear subject from the narration (a real place, a person doing the thing described, or a single telling object), the setting, the light, and a camera note such as "35mm lens, medium shot". Subject centred, because the picture is shown in a tall panel and cropped at the sides. No readable text, signs, logos or screens with interfaces (the video renders its own text). Do NOT default to an adviser and client at a desk, a laptop, or a skyline window; vary the seven scenes across places, people at work, objects and physical metaphors. Never use these words: cinematic, dramatic, glowing, ethereal, stunning, vibrant, majestic, epic, surreal, fantasy, artistic, render, 3D`;

  const userPrompt = hasContent
    ? `Article title: "${title}"

Full article (${wordCount} words):
${fullScript}

Write a tight 3–4 minute video script that summarises this article across exactly 7 scenes.
Each narration must be 60–70 words — written fresh for video, NOT copied verbatim from the article.
Cover the article's key points. Make each scene self-contained and engaging when spoken aloud.
Return a JSON object with a "scenes" array only — no markdown, no code fences, no explanation:

{ "scenes": [ { "sectionTitle": "Introduction", "narration": "...", "displayText": "...", "bullets": ["...", "...", "..."], "imagePrompt": "..." } ] }`
    : `Topic / title: "${title}"

No article text is provided. Write a complete 7-scene video script on this topic from scratch.
Target: 3–4 minutes total — 60–70 words of narration per scene.
Target audience: business owners and entrepreneurs interested in UAE and international corporate advisory.
Write with authority — real jurisdiction names, regulator names, realistic fee ranges, practical advice.
Each scene must cover a distinct aspect of the topic and flow naturally when spoken aloud.

Return a JSON object with a "scenes" array only — no markdown, no code fences:

{ "scenes": [ { "sectionTitle": "Introduction", "narration": "...", "displayText": "...", "bullets": ["...", "...", "..."], "imagePrompt": "..." } ] }`;

  // MEDIA_MODEL (gpt-4o by default) with response_format json_object + one
  // retry. Kept off gpt-5.5 because segmentation is a fast mechanical task and
  // reasoning latency overran the timeout; chatWithRetry adds rate-limit
  // handling and fail-fast on billing/auth errors.
  const MAX_ATTEMPTS = 2;
  let segments: RawVideoSegment[] | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { choices } = await chatWithRetry(openai, {
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }, { label: "videoScript", timeoutMs: 60_000, model: MEDIA_MODEL });

      const raw = choices[0].message.content?.trim() ?? "";
      const parsed = extractJson<{ scenes?: RawVideoSegment[] } | RawVideoSegment[]>(raw, "videoScript");
      const arr = Array.isArray(parsed) ? parsed : parsed.scenes;
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("no scenes array in response");
      segments = arr;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[videoScript] segmentation attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastErr}`);
    }
  }

  if (!segments) throw new Error(`Script segmentation failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);

  // Art-direction pass: rewrite the seven image briefs from each scene's own
  // narration with variety rules and the frame's constraints. Best-effort —
  // the segmentation's first-draft prompts remain if this fails.
  try {
    segments = await briefSceneImages(title, segments);
  } catch (err) {
    console.warn(`[videoScript] scene art direction failed, keeping first-draft prompts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Attach word counts — durations are placeholders until recalibrated
  // against the real audio length in generate-video/route.ts
  return segments.map((seg) => ({
    ...seg,
    bullets: Array.isArray(seg.bullets) ? seg.bullets : [],
    wordCount: countWords(seg.narration ?? ""),
    durationSeconds: 0, // recalibrated after audio generation
  }));
}

// ── Scene art direction ───────────────────────────────────────
// Until 2026-09-07 every scene came out as "an adviser and a client at a desk
// with a laptop and a skyline window", often with invented signage, because
// the segmentation prompt literally suggested that picture and nothing checked
// the seven prompts against each other. This pass rewrites the briefs from
// each scene's narration, with the frame's constraints and set-level limits,
// the same way lib/openai.ts briefs the four article images.

const SCENE_ART_DIRECTOR_PROMPT = `You are the art director for Aston VIP (aston.ae), an international corporate advisory firm headquartered in London and Dubai that advises founders, investors, family offices and regulated financial businesses on company formation, regulatory licensing, corporate banking and cross-border tax structuring.

You brief a photographer (an image model) for the still images behind a short explainer video. The house look is premium, credible, real-world editorial photography: real places, real materials, natural or motivated light, restrained colour, unhurried composition. Never stock-photo clichés, never renders or fantasy, never text layered on the picture.

Each still is on screen for about thirty seconds while a narrator speaks the scene's words. Viewers must be able to tell from the picture what that scene is about.`;

interface SceneImageDraft { index: number; concept: string; approach: string; setting: string; prompt: string }

const VIDEO_DIVERSITY_LIMITS = { maxOffices: 2, maxDuos: 2, maxSignage: 0, maxScreens: 1 };

function parseSceneDrafts(raw: string, count: number, label: string): SceneImageDraft[] {
  const parsed = extractJson<{ scenes?: Array<Partial<SceneImageDraft>> }>(raw, label);
  const list = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const out: SceneImageDraft[] = [];
  for (let i = 1; i <= count; i++) {
    const d = list.find((x) => Number(x?.index) === i) ?? list[i - 1];
    const prompt = d?.prompt?.trim() ?? "";
    if (!d || prompt.length < 30) throw new Error(`${label}: scene ${i} has no usable image prompt`);
    out.push({ index: i, concept: d.concept?.trim() ?? "", approach: d.approach?.trim() ?? "", setting: d.setting?.trim() ?? "", prompt });
  }
  return out;
}

/**
 * Rewrite each scene's imagePrompt from its narration. Seven different
 * pictures with different visual approaches, subject centred for the tall
 * crop, no readable text (the video renders its own), at most two office
 * interiors and one screen-led image. One revision round when the set is
 * flagged; recent videos' scenes are passed in as "already used".
 */
export async function briefSceneImages<T extends RawVideoSegment>(title: string, scenes: T[]): Promise<T[]> {
  if (scenes.length === 0) return scenes;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let recent: RecentImageConcept[] = [];
  try {
    const { getRecentImageConcepts } = await import("./storage");
    recent = await getRecentImageConcepts("video");
  } catch (err) {
    console.warn(`[sceneImages] could not load recent scene concepts (continuing without): ${err instanceof Error ? err.message : String(err)}`);
  }

  const userPrompt = `VIDEO: "${title}" — ${scenes.length} scenes.

HOW EACH PICTURE IS SHOWN
The frame is split: a navy panel on the left carries the scene title, one sentence and three bullets; the picture fills a tall panel on the right (about as tall as it is wide, cut from a 3:2 photograph, slowly zooming), under a light dark tint, with subtitles along the bottom. So: put the subject in the middle of the frame, keep the edges and the bottom sixth free of anything essential, prefer medium and wide shots with one clear subject, and avoid busy fine detail. The video renders all text itself, so the photograph must contain NO readable text, signs, logos, labels, captions or screens with interfaces.

THE SCENES AND THE WORDS HEARD OVER EACH ONE

${formatSceneBriefs(scenes)}
${recent.length ? `
PICTURES ALREADY USED IN RECENT VIDEOS (do not repeat these settings or subjects, and do not fall back to a generic version of them):
${formatRecentConcepts(recent, 21)}
` : ""}
HOW TO BRIEF EACH SCENE
1. Concept first: one sentence naming the specific idea in that scene's narration that the picture makes visible — a step, a decision, a consequence, a place, a threshold, an object that matters, a person doing the thing described. Not the topic in general.
2. Visual approach — spread the set across these, no approach used for two consecutive scenes and none more than twice in the video:
   A. Place: a real, identifiable location the narration refers to (a free-zone registry hall, the DIFC Gate walkway, Al Maryah Island from the water, a London chambers doorway, a Cypriot harbour town, a Frankfurt bank tower at dusk, a customs yard, a port).
   B. Human moment: someone doing what the narration describes, candid and mid-task, documentary style — a founder at a service counter, a courier with a sealed envelope, a witness signing, an auditor counting stock, a family at a kitchen table. Faces are fine; posed smiles to camera are not.
   C. Object or detail: one telling object, close and tactile — a stamped certificate, an embossed seal, a hardware wallet, a passport page, a bound ledger, a keycard, a bank security token, a fibre cable in a data hall.
   D. Concept made physical: a clean visual metaphor staged in a real environment — a corridor that forks for a choice, stacked glass floors for a holding structure, a row of gates for a perimeter test, a balance for a threshold, a bridge between two districts for cross-border flows.
   E. Process made physical: the steps or numbers laid out as real things — a timeline pinned along a wall, cards in sequence on a table, an architectural model, a whiteboard mid-session (shapes only, no legible words).
3. Vary the craft across the set: indoor and outdoor, city and room and object, different times of day and light, different dominant materials and colour accents, at least two wide shots and two close shots.
4. Hard limits for the whole video: at most TWO scenes set in an office, boardroom or meeting room. At most TWO scenes with two people at a table. At most ONE scene whose subject is a laptop, monitor or screen, and it must show no interface. NO scene with binders or documents on a desk in front of a skyline window. NO readable text anywhere in any scene. No real people's likenesses, no logos, flags, coins or currency symbols.
5. Write the prompt: 40 to 70 words, British English. Start with "A photograph of". One clear subject, its environment, the light, the camera distance and lens, the mood, then "photorealistic editorial photograph, subject centred, no readable text anywhere in the frame". Never use: cinematic, dramatic, glowing, ethereal, stunning, vibrant, majestic, epic, surreal, fantasy, artistic, render, 3D.

Return ONE valid JSON object and nothing else (no markdown, no code fences):
{ "scenes": [ { "index": 1, "concept": "one sentence", "approach": "A", "setting": "3 to 6 word label of the location and subject", "prompt": "the brief" }, … one entry per scene, in order ] }`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SCENE_ART_DIRECTOR_PROMPT },
    { role: "user", content: userPrompt },
  ];
  const labels = scenes.map((_, i) => `Scene ${i + 1}`);

  // Primary model (gpt-6-astra): the article briefs showed the reasoning model
  // produces far more specific concepts than gpt-4o, and the video pipeline is
  // durable, so the extra minute is affordable.
  const first = await chatWithRetry(openai, { messages }, { label: "sceneImages", timeoutMs: 150_000 });
  const firstRaw = assertCompleted(first, "sceneImages");
  let drafts = parseSceneDrafts(firstRaw, scenes.length, "sceneImages");
  let report = assessPromptDiversity(drafts.map((d) => d.prompt), labels, VIDEO_DIVERSITY_LIMITS);

  if (!report.ok) {
    console.warn(`[sceneImages] draft flagged, asking for a revision: ${report.issues.join(" | ")}`);
    try {
      const revision = await chatWithRetry(openai, {
        messages: [
          ...messages,
          { role: "assistant", content: firstRaw },
          { role: "user", content: `Revise the set. An automated check found these problems:\n- ${report.issues.join("\n- ")}\n\nKeep every picture anchored to its scene's narration, change only what is needed to fix the problems above (a different subject, setting or approach for the flagged scenes), and return the complete JSON object again with every scene.` },
        ],
      }, { label: "sceneImages:revise", timeoutMs: 150_000 });
      const revised = parseSceneDrafts(assertCompleted(revision, "sceneImages:revise"), scenes.length, "sceneImages:revise");
      const again = assessPromptDiversity(revised.map((d) => d.prompt), labels, VIDEO_DIVERSITY_LIMITS);
      if (again.issues.length <= report.issues.length) { drafts = revised; report = again; }
    } catch (err) {
      console.warn(`[sceneImages] revision unusable, keeping the first draft: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!report.ok) console.warn(`[sceneImages] still flagged after revision (using anyway): ${report.issues.join(" | ")}`);
  }

  for (const d of drafts) console.log(`[sceneImages] Scene ${d.index} (${d.approach || "?"}) ${d.setting || ""} — ${d.concept}`);

  try {
    const { rememberImageConcepts } = await import("./storage");
    const at = new Date().toISOString();
    await rememberImageConcepts(drafts.map((d) => ({
      post: title, slot: `scene_${d.index}`, at,
      concept: d.concept || d.prompt.slice(0, 120),
      setting: d.setting || d.approach || "unlabelled",
    })), "video");
  } catch (err) {
    console.warn(`[sceneImages] could not store scene concepts (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return scenes.map((sc, i) => ({ ...sc, imagePrompt: drafts[i].prompt }));
}
