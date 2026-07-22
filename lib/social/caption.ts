/**
 * lib/social/caption.ts
 * Turns one blog post into per-platform social captions, sized to each
 * platform's character budget and written in Aston's editorial voice
 * (British English, professional corporate-advisory tone).
 *
 * Reuses the shared, rate-limit-aware chat helper in lib/llm.ts. Per the
 * account's model constraints, gpt-5.x is called WITHOUT a temperature.
 */

import OpenAI from "openai";
import { chatWithRetry, assertCompleted, extractJson } from "@/lib/llm";
import type { SocialTarget } from "@/lib/social/types";
import { getSocialConnector } from "@/lib/social/registry";

export interface CaptionSource {
  title: string;
  /** Excerpt, key takeaways, or a short summary of the article. */
  summary: string;
  focusKeyword?: string;
  /** Canonical URL — the connector appends it, so we reserve room for it here. */
  link?: string;
}

export type PlatformCaptions = Partial<Record<SocialTarget, string>>;

const STYLE: Record<SocialTarget, string> = {
  facebook: "Warm and accessible for a broad professional audience. A hook plus a sentence of context. 1–3 hashtags.",
  instagram: "Visual-first and engaging. A strong hook, then value. 3–6 relevant hashtags at the end.",
  linkedin: "Authoritative and B2B. A strong professional hook, one or two sentences of insight, a subtle call to read. 2–4 industry hashtags.",
  tiktok: "Short, energetic video caption. A hook that fits a scroll. 2–4 trending-style but relevant hashtags.",
  youtube: "A YouTube Shorts description. A searchable first line with the topic, then a sentence of context. 3–5 relevant hashtags including #Shorts.",
};

/** Characters the connector will spend on the appended link (URL + two newlines). */
function linkReserve(link?: string): number {
  return link ? link.length + 2 : 0;
}

export async function generateCaptions(
  src: CaptionSource,
  targets: SocialTarget[]
): Promise<PlatformCaptions> {
  if (targets.length === 0) return {};

  const specs = targets.map((t) => {
    const limit = getSocialConnector(t).charLimit;
    const budget = Math.max(80, limit - linkReserve(src.link) - 2);
    return { target: t, budget, style: STYLE[t] };
  });

  const system = [
    "You are Aston VIP's social media copywriter. Aston VIP is a global corporate advisory firm (UAE, UK, DIFC, ADGM, VARA, offshore structures).",
    "Write social captions that promote a blog article and drive clicks.",
    "Rules:",
    "- British English only.",
    "- Professional, credible, corporate-advisory tone. No hype, no clickbait, no emoji spam (one tasteful emoji at most, usually none).",
    "- Do NOT include the article URL in the caption text — it is appended automatically.",
    "- Each caption (including its hashtags) MUST fit within the given character budget. Count characters and stay under budget.",
    "- When a focus keyword is given, weave it naturally into the caption text — ideally within the first sentence. This is a search signal on TikTok, Instagram and YouTube, so it must read naturally, never keyword-stuffed.",
    "- Hashtags go at the END of the caption (never mid-sentence). Make them relevant and specific (e.g. #DIFC #CorporateTax #UAEBusiness), not generic filler. Include a hashtag form of the focus keyword where it fits.",
    "Return ONLY a JSON object of the form:",
    '{ "captions": { "<platform>": "<caption text with hashtags>" } }',
    "with an entry for each requested platform and nothing else.",
  ].join("\n");

  const user = [
    `Article title: ${src.title}`,
    src.focusKeyword ? `Focus keyword: ${src.focusKeyword}` : "",
    `Summary: ${src.summary}`,
    "",
    "Write one caption per platform below. Respect each character budget exactly:",
    ...specs.map((s) => `- ${s.target} (max ${s.budget} characters): ${s.style}`),
  ]
    .filter(Boolean)
    .join("\n");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await chatWithRetry(
    openai,
    { max_completion_tokens: 4000, messages: [{ role: "system", content: system }, { role: "user", content: user }] },
    { label: "socialCaptions", timeoutMs: 90_000 }
  );
  const raw = assertCompleted(res, "socialCaptions");
  const parsed = extractJson<{ captions?: Record<string, string> }>(raw, "socialCaptions");

  // Keep only requested platforms, and hard-trim anything that came back over budget.
  const out: PlatformCaptions = {};
  for (const spec of specs) {
    const text = parsed.captions?.[spec.target]?.trim();
    if (!text) continue;
    out[spec.target] = text.length > spec.budget ? text.slice(0, spec.budget - 1).trimEnd() + "…" : text;
  }
  return out;
}
