/**
 * lib/imageBrief.ts
 * ─────────────────────────────────────────────────────────────
 * Pure helpers behind generateImagePrompts(): turn the finished article into
 * a per-slot brief that says exactly WHERE each of the four images sits on
 * the page and WHICH text the reader sees next to it, and check that four
 * drafted prompts are genuinely different pictures.
 *
 * No SDK imports — unit-tested directly (tests/imageBrief.test.ts) and safe
 * to import from steps, routes and the dashboard alike.
 *
 * Page template (the single-post Elementor layout on aston.ae, verified
 * against a live post on 2026-09-07):
 *
 *   H1 title
 *   ▸ FEATURED image
 *   key takeaways
 *   main_content (introduction)
 *   ▸ KEYPOINT ONE pull-out sentence + keypoint_one_img
 *   more_content_1, more_content_2 (+ flowchart), quote_1, more_content_3
 *   more_content_4 (the Aston VIP section), quote_2
 *   ▸ post_split_img (full width)
 *   more_content_5 (FAQ)
 *   ▸ KEYPOINT TWO pull-out sentence + Keypoint_Two_Img
 *   final_points, more_content_6
 *
 * Before 2026-09-07 the prompt writer only saw the first 400 characters of
 * three sections and forced every picture through one camera/lighting
 * suffix, so six consecutive posts came out as the same "binder on a desk in
 * front of a skyline window" photograph. The client noticed.
 */

export type ImageSlot = "featured" | "keypoint_one" | "post_split" | "keypoint_two";

export const IMAGE_SLOTS: readonly ImageSlot[] = ["featured", "keypoint_one", "post_split", "keypoint_two"] as const;

export const IMAGE_SLOT_LABELS: Record<ImageSlot, string> = {
  featured:     "Hero",
  keypoint_one: "Keypoint 1",
  post_split:   "Split",
  keypoint_two: "Keypoint 2",
};

/** The article fields the brief builder reads. Every field is optional so
 *  both the generation run (full BlogContent) and the Add media page (ACF
 *  fields read back from WordPress) can supply it. */
export interface ImageBriefContent {
  focus_keyword?: string;
  secondary_keywords?: string[];
  key_takeaways?: string;
  main_content?: string;
  keypoint_one?: string;
  more_content_1?: string;
  more_content_2?: string;
  quote_1?: string;
  more_content_3?: string;
  keypoint_two?: string;
  more_content_4?: string;
  quote_2?: string;
  more_content_5?: string;
  more_content_6?: string;
  final_points?: string;
}

export interface ImageSlotBrief {
  slot: ImageSlot;
  /** Where the picture sits on the page, in plain words. */
  placement: string;
  /** The text the reader sees right next to the picture — what it must illustrate. */
  anchorText: string;
  /** What the reader has just read when they reach the picture. */
  before: string;
  /** What comes straight after it. */
  after: string;
}

/** One picture we have already briefed on the site — kept so the next article
 *  does not reach for the same setting or subject again. */
export interface RecentImageConcept {
  post: string;
  slot: ImageSlot;
  concept: string;
  setting: string;
  at: string; // ISO timestamp
}

// ── HTML → text ───────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip markup and collapse whitespace. `max` cuts on a word boundary and appends an ellipsis. */
export function htmlToText(html: string | null | undefined, max = Infinity): string {
  if (!html) return "";
  const text = decodeEntities(
    html
      .replace(/<(script|style|canvas)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote|figure)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** H2/H3/H4 headings in document order, as plain text. */
export function extractHeadings(html: string | null | undefined): string[] {
  if (!html) return [];
  const out: string[] = [];
  const re = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = htmlToText(m[2]);
    if (t) out.push(t);
  }
  return out;
}

/** Body text of a section with its headings removed, so "opening" really is the first prose. */
function bodyText(html: string | null | undefined, max: number): string {
  if (!html) return "";
  return htmlToText(html.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, " "), max);
}

/** "Headings: A / B / C. Opens: …" for a section, or "" when the section is empty. */
export function sectionOutline(html: string | null | undefined, chars = 360): string {
  const headings = extractHeadings(html);
  const opening = bodyText(html, chars);
  if (!headings.length && !opening) return "";
  const parts: string[] = [];
  if (headings.length) parts.push(`Headings: ${headings.join(" / ")}.`);
  if (opening) parts.push(`Opens: "${opening}"`);
  return parts.join(" ");
}

/** The last `chars` characters of a section's prose — what the reader has just finished. */
function sectionEnding(html: string | null | undefined, chars = 320): string {
  const text = bodyText(html, Infinity);
  if (!text) return "";
  if (text.length <= chars) return text;
  const tail = text.slice(-chars);
  const firstSpace = tail.indexOf(" ");
  return "…" + (firstSpace >= 0 && firstSpace < chars * 0.4 ? tail.slice(firstSpace + 1) : tail);
}

/** Every heading across the article in page order — the model's map of the piece. */
export function articleOutline(content: ImageBriefContent): string[] {
  const order: Array<keyof ImageBriefContent> = [
    "main_content", "more_content_1", "more_content_2", "more_content_3",
    "more_content_4", "more_content_5", "more_content_6",
  ];
  return order.flatMap((k) => extractHeadings(content[k] as string | undefined));
}

// ── Per-slot briefs ───────────────────────────────────────────

export function buildImageBriefs(title: string, content: ImageBriefContent): ImageSlotBrief[] {
  const takeaways = htmlToText(content.key_takeaways, 700);
  const faqQuestions = extractHeadings(content.more_content_5).slice(0, 3);
  const source3 = sectionOutline(content.more_content_3, 300);
  const finalPoints = htmlToText(content.final_points, 320);
  const lastHeading = extractHeadings(content.more_content_6)[0];

  return [
    {
      slot: "featured",
      placement: "Hero image at the very top of the page, directly under the title and above the key takeaways. It stands for the whole article and is what shows in link previews and listings.",
      anchorText: [`Title: "${title}"`, takeaways ? `Key takeaways: ${takeaways}` : ""].filter(Boolean).join("\n"),
      before: "",
      after: sectionOutline(content.main_content, 400),
    },
    {
      slot: "keypoint_one",
      placement: "Sits directly after the introduction, side by side with this pull-out sentence (the reader sees the sentence and the picture as one block), just before the first body section.",
      anchorText: htmlToText(content.keypoint_one, 600) || bodyText(content.main_content, 400),
      before: sectionEnding(content.main_content),
      after: sectionOutline(content.more_content_1, 300),
    },
    {
      slot: "post_split",
      placement: "Full-width image placed after the Aston VIP advisory section and its closing quote, immediately before the FAQ. It bridges the advisory section to the reader's questions.",
      anchorText: [
        htmlToText(content.quote_2) ? `Closing quote beside it: "${htmlToText(content.quote_2, 300)}"` : "",
        sectionOutline(content.more_content_4, 450) ? `Section it follows: ${sectionOutline(content.more_content_4, 450)}` : "",
      ].filter(Boolean).join("\n"),
      before: sectionEnding(content.more_content_4),
      after: faqQuestions.length ? `FAQ that follows: ${faqQuestions.join(" / ")}` : sectionOutline(content.more_content_5, 240),
    },
    {
      slot: "keypoint_two",
      placement: "Sits after the FAQ, side by side with this pull-out sentence, just before the final points that close the article.",
      anchorText: htmlToText(content.keypoint_two, 600) || bodyText(content.more_content_3, 400),
      before: [
        faqQuestions.length ? `Reader has just finished the FAQ (${faqQuestions.slice(0, 2).join(" / ")}).` : "",
        source3 ? `The pull-out sentence was drawn from this earlier section — ${source3}` : "",
      ].filter(Boolean).join(" "),
      after: [finalPoints ? `Final points: ${finalPoints}` : "", lastHeading ? `Then the closing section "${lastHeading}".` : ""].filter(Boolean).join(" "),
    },
  ];
}

/** Render the briefs as the block the model reads. */
export function formatImageBriefs(briefs: ImageSlotBrief[]): string {
  return briefs.map((b, i) => {
    const lines = [`${i + 1}) ${b.slot}`, `   Where: ${b.placement}`];
    if (b.anchorText) lines.push(`   Text beside it (this is what the picture must make visible):\n   ${b.anchorText.replace(/\n/g, "\n   ")}`);
    if (b.before) lines.push(`   The reader has just read: "${b.before}"`);
    if (b.after) lines.push(`   What comes next: ${b.after}`);
    return lines.join("\n");
  }).join("\n\n");
}

export function formatRecentConcepts(list: RecentImageConcept[], max = 24): string {
  return list.slice(0, max).map((c) => `- ${c.setting}: ${c.concept}`).join("\n");
}

// ── Diversity check ───────────────────────────────────────────

const STOP = new Set((
  "a an the and or of in on at to for with from by as is are was be this that these those it its into over under " +
  "between through across near behind beside above below out up down off one two three four " +
  "shot lens mm f/1.4 f/1.8 f/2 f/2.8 f/4 depth field shallow focus sharp ultra photo photograph photography photographic " +
  "photorealistic realistic editorial cinematic professional corporate image picture scene composition frame framing " +
  "light lighting lit natural soft warm cool daylight golden hour morning afternoon evening sunlight window-light " +
  "colour color palette grade graded tone tones tonal neutral muted restrained mood atmosphere atmospheric quiet calm " +
  "premium high-end luxury elegant refined clean minimal minimalist modern contemporary " +
  "no text overlay overlays caption captions watermark logo logos banner flag flags coin coins currency symbol symbols " +
  "camera wide medium close close-up macro angle low high eye-level view perspective background foreground " +
  "canon eos r5 sony a7r nikon fujifilm leica hasselblad 35mm 50mm 85mm 24mm 24-70mm " +
  "very slightly gently softly subtly detailed detail details realistic real world"
).split(/\s+/));

function contentWords(prompt: string): Set<string> {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\-\s]/g, " ").split(/\s+/).filter(Boolean);
  return new Set(words.filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+(mm|k)?$/.test(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

const DESK   = /\b(desk|table|boardroom|conference room|meeting room)\b/i;
const PAPERS = /\b(binder|binders|folder|folders|dossier|dossiers|document|documents|paperwork|papers|report|reports|files?|certificates?|contracts?|brochures?)\b/i;
const VIEW   = /\b(skyline|window|windows|towers?|cityscape|city view|floor-to-ceiling|burj)\b/i;
const OFFICE = /\b(office|boardroom|meeting room|conference room|reception)\b/i;
const DUO    = /\b(two|2|pair of) (men|businessmen|women|professionals|executives|advisers|advisors|colleagues|people|consultants|founders|lawyers)\b/i;
const SIGNAGE = /\b(signs?|signage|signboards?|nameplates?|plaques?|lettering|embossed|engraved|titled|labelled|labeled|wordmark|inscription|reads ["“])\b/i;

export interface DiversityReport {
  ok: boolean;
  issues: string[];
}

/**
 * Flag drafts that are the same picture wearing different words: near-identical
 * wording, more than one office interior, more than one "two men at a table",
 * legible text in more than one image, and the documents-on-a-desk-with-a-
 * skyline recipe that the site's images collapsed into.
 */
export function assessPromptDiversity(prompts: string[], labels: string[] = prompts.map((_, i) => `Image ${i + 1}`)): DiversityReport {
  const issues: string[] = [];
  const sets = prompts.map(contentWords);

  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      const sim = jaccard(sets[i], sets[j]);
      if (sim >= 0.34) issues.push(`${labels[i]} and ${labels[j]} describe nearly the same picture (${Math.round(sim * 100)}% of their subject words are shared).`);
      const openI = [...sets[i]].slice(0, 5).join(" "), openJ = [...sets[j]].slice(0, 5).join(" ");
      if (openI && openI === openJ) issues.push(`${labels[i]} and ${labels[j]} open with the same subject.`);
    }
  }

  prompts.forEach((p, i) => {
    if (DESK.test(p) && PAPERS.test(p) && VIEW.test(p)) {
      issues.push(`${labels[i]} is the documents-on-a-desk-in-front-of-a-skyline-window picture the site already overuses; pick a different subject and setting.`);
    }
  });

  const offices = prompts.map((p, i) => (OFFICE.test(p) ? labels[i] : null)).filter(Boolean) as string[];
  if (offices.length > 1) issues.push(`${offices.join(", ")} are all office interiors; at most one image per article may be set in an office.`);

  const duos = prompts.map((p, i) => (DUO.test(p) ? labels[i] : null)).filter(Boolean) as string[];
  if (duos.length > 1) issues.push(`${duos.join(", ")} all show two people at a table; use that at most once.`);

  const signs = prompts.map((p, i) => (SIGNAGE.test(p) ? labels[i] : null)).filter(Boolean) as string[];
  if (signs.length > 1) issues.push(`${signs.join(", ")} all rely on legible in-scene text or signage; only one image may.`);

  return { ok: issues.length === 0, issues };
}

/** Pull the optional per-slot concept fields off an ImagePrompts object. */
export function conceptsFromPrompts(p: {
  featured_img_concept?: string; keypoint_one_img_concept?: string;
  post_split_img_concept?: string; keypoint_two_img_concept?: string;
} | null | undefined): Partial<Record<ImageSlot, string>> | undefined {
  if (!p) return undefined;
  const out: Partial<Record<ImageSlot, string>> = {};
  if (p.featured_img_concept?.trim())     out.featured     = p.featured_img_concept.trim();
  if (p.keypoint_one_img_concept?.trim()) out.keypoint_one = p.keypoint_one_img_concept.trim();
  if (p.post_split_img_concept?.trim())   out.post_split   = p.post_split_img_concept.trim();
  if (p.keypoint_two_img_concept?.trim()) out.keypoint_two = p.keypoint_two_img_concept.trim();
  return Object.keys(out).length ? out : undefined;
}
