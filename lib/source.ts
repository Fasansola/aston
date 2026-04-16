/**
 * lib/source.ts
 * ─────────────────────────────────────────────────────────────
 * Source / Research Engine — processes raw source inputs into a
 * structured brief that the blueprint and content generators use.
 *
 * Four generation modes:
 *  topic_only       — no source; AI writes from knowledge (Mode A)
 *  source_assisted  — external article or research; extract facts,
 *                     write a fully original Aston article (Mode B)
 *  improve_existing — existing Aston post; refresh structure, SEO,
 *                     links, FAQ without losing the original value (Mode C)
 *  notes_to_article — rough notes or bullet points; expand into a
 *                     complete structured article (Mode D)
 */

import OpenAI from "openai";

export type GenerationMode =
  | "topic_only"
  | "source_assisted"
  | "improve_existing"
  | "notes_to_article";

export interface SourceBrief {
  mode: GenerationMode;
  summary: string;
  key_facts: string[];
  key_angles: string[];
  questions_to_answer: string[];
  avoid_reusing: string[];
}

// ── Mode A — no processing needed ────────────────────────────

export function emptyBrief(): SourceBrief {
  return {
    mode: "topic_only",
    summary: "",
    key_facts: [],
    key_angles: [],
    questions_to_answer: [],
    avoid_reusing: [],
  };
}

// ── Modes B / C / D — process source text with GPT ───────────

const MODE_INSTRUCTIONS: Record<Exclude<GenerationMode, "topic_only">, string> = {
  source_assisted: `You are analysing a source article that will be used as reference material only.
Your job is to extract the most valuable facts, angles, and questions — NOT to summarise or paraphrase the article.
The final blog will be a completely original Aston VIP article. It must not copy sentence structure, headings, or distinctive phrasing from the source.

Extract:
- key_facts: specific facts, figures, names, dates, costs, timelines, regulations — only things that are genuinely useful
- key_angles: the most interesting subtopics and perspectives in the source that an Aston article should cover (in its own way)
- questions_to_answer: questions a real reader would ask that the source article answers
- avoid_reusing: any distinctive phrases, headings, or structural patterns from the source that must NOT appear in our article`,

  improve_existing: `You are analysing an existing Aston VIP blog post that needs to be improved.
Your job is to identify what is good (worth keeping), what is weak (needs rewriting), and what is missing.

Extract:
- key_facts: the strongest factual claims already in the article that should be preserved
- key_angles: the main angles currently covered — these should be kept and strengthened
- questions_to_answer: questions that are currently missing from the article (gaps to fill)
- avoid_reusing: any weak, generic, or outdated sections that should be replaced entirely`,

  notes_to_article: `You are analysing rough notes, bullet points, or internal research that need to be turned into a full blog post.
Your job is to extract the intent and key points, then identify what additional content is needed to make a complete article.

Extract:
- key_facts: the concrete facts or claims stated in the notes
- key_angles: the main topics and themes the notes are pointing at
- questions_to_answer: questions implied by the notes that the final article must answer
- avoid_reusing: any raw/unpolished phrasing from the notes that should be rewritten`,
};

/**
 * Process source text into a structured brief for Modes B, C, and D.
 * The brief is then injected into the blueprint and content prompts.
 */
export async function processSourceInput(
  mode: Exclude<GenerationMode, "topic_only">,
  title: string,
  sourceText: string
): Promise<SourceBrief> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const instructions = MODE_INSTRUCTIONS[mode];

  const userPrompt = `Blog title we are writing: "${title}"

${instructions}

SOURCE MATERIAL:
---
${sourceText.slice(0, 6000)}
---

Return a single valid JSON object. No markdown, no code fences:

{
  "summary": "string — one sentence describing what the source material is about",
  "key_facts": ["string", "string", "string"],
  "key_angles": ["string", "string", "string"],
  "questions_to_answer": ["string", "string", "string"],
  "avoid_reusing": ["string", "string"]
}

Rules:
- key_facts: 4-8 items. Each must be a specific, usable fact (not a vague theme)
- key_angles: 3-5 items. Each is a distinct subtopic or perspective
- questions_to_answer: 3-5 real questions a reader would ask
- avoid_reusing: 2-5 items — specific phrases, headings, or patterns to avoid
- If the source is thin or off-topic, return fewer items rather than inventing content`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.3,
    max_tokens: 1000,
  });

  const raw = response.choices[0].message.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `No JSON found in source brief response. Raw: ${raw.slice(0, 200)}`
    );
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { mode, ...parsed } as SourceBrief;
  } catch {
    throw new Error(
      `Source brief returned invalid JSON. Raw: ${raw.slice(0, 200)}`
    );
  }
}

// ── Format brief for prompt injection ────────────────────────

export function formatBriefForPrompt(brief: SourceBrief): string {
  if (brief.mode === "topic_only" || !brief.summary) return "";

  const modeLabel: Record<GenerationMode, string> = {
    topic_only: "",
    source_assisted:
      "SOURCE MATERIAL (use as reference only — do NOT copy structure or phrasing):",
    improve_existing:
      "EXISTING ARTICLE ANALYSIS (preserve strengths, fix gaps, improve everything else):",
    notes_to_article:
      "NOTES TO EXPAND (use as raw material — write a complete polished article):",
  };

  const lines: string[] = [modeLabel[brief.mode], `Summary: ${brief.summary}`];

  if (brief.key_facts.length > 0) {
    lines.push(
      `Key facts to use:\n${brief.key_facts.map((f) => `- ${f}`).join("\n")}`
    );
  }
  if (brief.key_angles.length > 0) {
    lines.push(
      `Angles to cover:\n${brief.key_angles.map((a) => `- ${a}`).join("\n")}`
    );
  }
  if (brief.questions_to_answer.length > 0) {
    lines.push(
      `Questions the article must answer:\n${brief.questions_to_answer.map((q) => `- ${q}`).join("\n")}`
    );
  }
  if (brief.avoid_reusing.length > 0) {
    lines.push(
      `Do NOT reuse these phrases or patterns:\n${brief.avoid_reusing.map((x) => `- ${x}`).join("\n")}`
    );
  }

  return lines.join("\n\n");
}
