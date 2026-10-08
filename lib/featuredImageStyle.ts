/**
 * lib/featuredImageStyle.ts
 * ─────────────────────────────────────────────────────────────
 * How FEATURED (hero) images are briefed. Pure: no I/O, no SDK.
 *
 * History
 *  - 2026-10-05: the client supplied 17 reference featured images
 *    (assets/image-references/ in the main checkout). The first version of
 *    this file read them as ONE formula — office, skyline window, gold-titled
 *    dossier, regulator lettering — fixed the camera and told the model to
 *    vary "the subject, never the formula".
 *  - 2026-10-08: the client showed the blog library: eight posts in a row with
 *    the same cream book, the same Burj Khalifa window and the same "Central
 *    Bank of the UAE" wall. Readers could not tell posts apart. The references
 *    were meant to show the LEVEL OF DETAIL, not one composition — they
 *    actually span consultations, hands handing over folders, a figure at the
 *    window, an outdoor still life at ADGM, a side-by-side comparison, a
 *    flowchart on a laptop, a trading desk by a vault, a residence lounge.
 *
 * So now:
 *  - the references set a DETAIL BAR (DETAIL_STANDARD) every featured image
 *    must meet: several topic-specific props, exact text from the article,
 *    layered depth, the place and authority made unmistakable;
 *  - the CODE, not the model, assigns each post a VARIATION CARD from an
 *    atomic sequence number (storage.nextFeaturedImageSeq): one of nine scene
 *    types (avoiding the ones used most recently and preferring those that fit
 *    the topic), plus light, colour palette, surface, camera, hero object,
 *    where the authority appears and which landmark is seen. Each axis rotates
 *    with its own stride, so consecutive posts — even a batch generated at the
 *    same moment on near-identical topics — differ on every axis;
 *  - assessFeaturedPrompt() checks the brief against its card, the detail
 *    bar, and the recent featured briefs (word overlap), and sends it back
 *    once if it falls short.
 */

import { promptSimilarity } from "./imageBrief";

// ── Scene types (from the references) ──────────────────────────

export interface FeaturedScene {
  id: string;
  name: string;
  /** What the picture is, for the brief. */
  description: string;
  /** Whether a window view belongs in this scene. */
  view: "window" | "optional" | "exterior" | "none";
  /** Camera options that suit the scene (indexes into CAMERAS). */
  cameras: number[];
  /** Topic words that make this scene a natural fit (null: fits anything). */
  fits: RegExp | null;
  /** Only use this scene when `fits` matches (it would misrepresent other topics). */
  fitOnly?: boolean;
  example: { article: string; prompt: string };
}

export const CAMERAS = [
  "wide establishing view (24mm lens) that shows the whole room or place",
  "medium view at seated eye level (35mm lens)",
  "close over-the-shoulder view (50mm lens)",
  "high three-quarter view looking down across the table (35mm lens)",
  "close detail view (85mm lens) with very shallow depth of field",
] as const;

export const FEATURED_SCENES: FeaturedScene[] = [
  {
    id: "consultation",
    name: "Advisory consultation",
    description: "an adviser and a client mid-conversation over the hero document at a table, both absorbed in it; the subject's props spread between them",
    view: "optional", cameras: [0, 1, 2], fits: null,
    example: {
      article: "DMCC gold trading license",
      prompt: `Medium view at seated eye level inside a DMCC advisory office in Jumeirah Lakes Towers, bright late-morning light from tall windows onto the lakes and towers. Large brushed-gold letters "DMCC" with "Dubai Multi Commodities Centre" beneath on a dark marble wall. At a black marble table an adviser in a navy suit and an Emirati client in a white kandura and ghutra study a printed trade document headed "Gold Trading License Application", the adviser pointing with a pen; in the sharp foreground, stacked gold bullion bars and small ingots in black presentation trays, a closed black leather portfolio and a crystal water glass. Natural, mid-conversation, nobody facing the camera, deep navy and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "handover",
    name: "Hands handing over documents",
    description: "a close, over-the-shoulder moment: one pair of hands passing the titled hero document across a desk to another, the receiving hands and a watch cuff in the foreground",
    view: "optional", cameras: [2, 3, 4], fits: null,
    example: {
      article: "Can you use a nominee without giving up control of your company?",
      prompt: `Close over-the-shoulder view across a black-and-white veined marble desk in a Business Bay advisory office, golden-hour light from a window onto the canal and towers. One hand slides a white folder titled "Nominee" with "Director · Shareholder" beneath across the desk; in the foreground the client's hands, a steel watch at the cuff, hold a black hardcover folder stamped in gold "Your Company" and "Full Control". To the left, four dark hardback books with gold spines reading "UAE Corporate Law", "Nominee Structures", "Asset Protection" and "International Business"; a black-and-gold fountain pen and a small UAE desk flag. Black and gold, shallow depth of field, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "window_figure",
    name: "Figure at the window",
    description: "one professional seen from behind or in profile at floor-to-ceiling glass, contemplating the city; the subject's props sharp on a desk or console in the foreground",
    view: "window", cameras: [0, 1], fits: null,
    example: {
      article: "How to structure RWA tokenisation in Dubai",
      prompt: `Wide establishing view of a high-floor private office above Business Bay at blue hour, the city lights coming on outside the floor-to-ceiling glass. A bearded man in a dark suit stands with his back half-turned, looking out over the towers. On the polished smoked-glass desk in the sharp foreground: a detailed architectural scale model of a residential tower on a plinth with a brass plate reading "Business Bay Residences · 120 Tokens", a neat pyramid of gold bars, and an open ring binder of printed valuation tables headed "Tokenised Asset Register". Faint translucent network lines are etched on the glass. Warm lamplight inside against the blue city, slate grey and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "exterior",
    name: "Outdoor still life at the authority",
    description: "an outdoor still life on a stone ledge, bench or plaza table directly in front of the authority's or free zone's real building, its name visible on the facade behind",
    view: "exterior", cameras: [1, 3, 4], fits: /\b(adgm|difc|dmcc|vara|free ?zone|authority|regulator|foundation|trust|centre|center|registry|ministry|court)\b/i,
    example: {
      article: "A founder's guide to ADGM trust and foundation setup",
      prompt: `Medium view at the edge of the plaza on Al Maryah Island at golden hour, the ADGM building behind with "Abu Dhabi Global Market" and its ring emblem lit on the glass facade, trees and the waterway catching the light. On a polished grey marble ledge in the sharp foreground: a navy leather folder with a gold ring motif titled "ADGM Foundation Charter", an ivory sheet headed "Trust Deed", a heavy bronze seal medallion inscribed "Abu Dhabi Global Market", a black document tube stamped "ADGM" and a black-and-gold fountain pen. Warm low sun, long reflections, deep navy and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "comparison",
    name: "Side-by-side comparison",
    description: "a symmetrical tableau of two of everything — two titled folders, two table flags, two scale models or two sets of props — one per option being compared",
    view: "optional", cameras: [1, 3], fitOnly: true, fits: /\b(vs\.?|versus|compar\w*|choos\w*|which|alternatives?|between|best)\b/i,
    example: {
      article: "Dubai vs Panama company setup beyond the headlines",
      prompt: `High three-quarter view across a long charcoal leather-topped table in a warm, book-lined boardroom with a framed antique world map. Side by side in the sharp foreground: a navy leather folder titled in gold "Dubai free zone company" and a stone-grey folder titled "Panama offshore company", separated by a brass pen tray; a small UAE table flag at the left end and a Panama flag at the right on brass stands; behind each folder a detailed architectural scale model, Dubai's towers and creek on one side and the Panama Canal waterfront with ships on the other. Warm interior lamplight, rich browns and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "screen_workflow",
    name: "Desk with the process on screen",
    description: "a working desk where a laptop or tablet shows a clear diagram of the article's real process or decision route, a handwritten checklist of the actual steps beside it, a hand mid-note",
    view: "optional", cameras: [1, 2, 3], fits: /\b(how|steps?|process|route|apply|application|setup|set up|open\w*|register\w*|renew\w*|timeline|checklist|guide|requirements?)\b/i,
    example: {
      article: "How to choose the right Dubai crypto license route",
      prompt: `Close over-the-shoulder view at a dark marble desk in a high-floor Dubai office, bright clear daylight from the window. An open laptop shows a crisp decision diagram titled "Dubai Crypto License: Choose the Right Route" branching from "What are you planning to do?" into "Exchange", "Broker / Dealer", "Asset Management" and "Advisory", each ending in a box marked "VARA" or "DFSA". In the foreground a hand in a navy suit cuff writes on a notepad headed "Key considerations" with a short ticked list; beside it a magazine titled "Dubai Crypto Guide", a black mug marked "Aston VIP" and four dark books with gold spines. Navy and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "operations",
    name: "Operations in progress",
    description: "the real place where the subject's work is done, mid-task: a trading desk beside a vault door, a custody room, a payments operations desk, a gold vault, a customs yard, a registry counter — one professional at work",
    view: "optional", cameras: [0, 1, 2], fits: /\b(crypto|bank\w*|payment\w*|emi|psp|custody|gold|bullion|trading|tokeni\w*|fund\w*|exchange|broker\w*|msb|vasp|casp|asset|treasury|settlement|customs|import\w*|export\w*)\b/i,
    example: {
      article: "How UAE crypto banking will work for institutions",
      prompt: `Wide establishing view of a private banking operations floor high in DIFC at dusk. On the left, a glass-walled corridor leads to a polished steel vault door, with racks of blue-lit servers behind glass; on a travertine wall the words "Private Banking · Asset Operations" in brushed metal. On the right a man in a dark suit sits at a walnut desk facing a large monitor showing live "BTC" and "ETH" price charts and an order book, a closed black notebook and a pen beside the keyboard; through the window the towers of Sheikh Zayed Road glow. Cool blue screen light against warm amber lamps, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "lounge",
    name: "Residence or private lounge",
    description: "a calm luxury residence, family office or private members' lounge rather than an office: personal documents and keys arranged on a marble or wood side table, soft furnishings beyond",
    view: "optional", cameras: [1, 3, 4], fits: /\b(visa|residen\w*|property|home|family|golden|wealth|relocat\w*|moving|citizenship|trust|founder|retire\w*|private|personal|succession)\b/i,
    example: {
      article: "Who now qualifies for a Dubai property visa",
      prompt: `Medium view across a round white-and-grey veined marble table in a sunlit Downtown Dubai residence, a cream sofa, a brass floor lamp and a gold vase of white blossom softly out of focus, floor-to-ceiling windows onto the towers beyond. In the sharp foreground: a navy UAE passport with the gold national emblem, an Emirates ID card tucked in a taupe leather card holder, and an ivory document folder titled "Dubai Property" with "Visa Application" beneath and a skyline photograph on the cover, a black-and-gold pen resting across it. Bright late-morning light, ivory and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
  {
    id: "macro",
    name: "Telling detail, close up",
    description: "an extreme close-up of the single most telling object — an embossed seal on a licence, a stamped gold bar, a card terminal mid-tap, a calendar page on the deadline — with two or three supporting props softly behind",
    view: "none", cameras: [4], fits: null,
    example: {
      article: "When your UAE Corporate Tax return is actually due",
      prompt: `Close detail view, 85mm, very shallow depth of field, on a dark walnut desk at golden hour. Pin-sharp in the foreground: a desk calendar open on "September 2026" with a large "30" and "Wednesday" beneath, the corner of a navy leather folder stamped in gold "UAE Corporate Tax Return 2026" leaning against it, and a black fountain pen resting on a printed return form headed "Corporate Tax Return". Softly behind: three dark hardback books with gold spines reading "VAT", "UAE Corporate Tax" and "Finance Act", and a black mug with a gold emblem. Warm raking light, black and gold, photorealistic premium editorial photograph, 3:2.`,
    },
  },
];

// ── Variation axes (each rotates with its own stride) ──────────

export const LIGHTS = [
  "soft early-morning light, low sun and long gentle shadows",
  "bright, clear late-morning daylight",
  "warm golden-hour sunlight raking across the scene",
  "blue hour at dusk, city lights coming on, warm lamps inside",
  "night, the city lit up beyond, pools of warm lamplight",
  "soft overcast daylight, even and calm",
  "crisp midday sun with sharp shadows and reflections",
] as const;

/** Colours of the hero object and the scene's accents. */
export const PALETTES = [
  "deep navy and gold",
  "black and gold with dark stone",
  "burgundy leather and brass",
  "forest green and antique gold",
  "ivory and charcoal with walnut",
  "tan saddle leather and brushed brass",
  "slate grey and silver with white marble",
] as const;

export const SURFACES = [
  "black Nero Marquina marble with white veins",
  "white Calacatta marble",
  "dark walnut",
  "smoked glass",
  "honey travertine",
  "green leather desk inlay",
] as const;

export const HERO_OBJECTS = [
  "a hardcover dossier with a foil-stamped cover title",
  "an open leather presentation portfolio",
  "a ring binder with a printed cover and spine",
  "a licence or certificate in a leather folder, its seal visible",
  "a tablet showing the article's process as a clear diagram",
  "a sealed envelope with an embossed seal and a cover letter",
  "a document box with labelled index tabs",
] as const;

export const AUTHORITY_PLACEMENTS = [
  "in brushed-metal lettering on a wall",
  "on the letterhead or embossed seal of the hero document",
  "on the building facade in the background",
  "on a small desk plaque",
  "on a laptop or tablet screen",
  "not at all: let the props carry the subject",
] as const;

/** Recognisable views, so the Burj Khalifa stops being every picture. */
export const PLACE_VIEWS: Record<string, readonly string[]> = {
  difc: [
    "The Gate building at the heart of DIFC",
    "Gate Avenue in DIFC with its arcades",
    "the Emirates Towers on Sheikh Zayed Road",
    "the Museum of the Future beside the Emirates Towers",
  ],
  dmcc: [
    "the Jumeirah Lakes Towers clusters around their lakes",
    "Uptown Tower and the JLT skyline",
    "Dubai Marina's towers seen from JLT",
  ],
  abu_dhabi: [
    "the Al Maryah Island towers and waterfront",
    "the Abu Dhabi Corniche and its towers",
    "the Etihad Towers",
    "the Saadiyat Island cultural district across the water",
  ],
  dubai: [
    "Dubai Marina's towers and yachts",
    "the Museum of the Future and the Emirates Towers on Sheikh Zayed Road",
    "Dubai Creek with wooden dhows and the Deira waterfront",
    "the Business Bay canal and its towers",
    "the Dubai Frame above Zabeel Park",
    "Palm Jumeirah and the Gulf from high above",
    "the Burj Khalifa and Downtown",
  ],
};

export function detectPlace(text: string): keyof typeof PLACE_VIEWS | "other" {
  const t = text.toLowerCase();
  if (/\bdifc\b|dubai international financial centre|\bdfsa\b/.test(t)) return "difc";
  if (/\bdmcc\b|jumeirah lakes|\bjlt\b/.test(t)) return "dmcc";
  if (/\badgm\b|abu dhabi|\bfsra\b|al maryah/.test(t)) return "abu_dhabi";
  if (/\bdubai\b|\buae\b|emirates|\bvara\b|\bmainland\b/.test(t)) return "dubai";
  return "other";
}

// ── The variation card ─────────────────────────────────────────

export interface FeaturedVariation {
  seq: number;
  scene: FeaturedScene;
  camera: string;
  light: string;
  palette: string;
  surface: string;
  heroObject: string;
  authority: string;
  /** Null when the scene has no view or the place is not a known one. */
  view: string | null;
  place: string;
}

const pick = <T>(list: readonly T[], seq: number, stride: number): T =>
  list[((seq * stride) % list.length + list.length) % list.length];

/**
 * Assign this post's picture setup. Deterministic for a given sequence number,
 * topic and recent scenes, so it is testable and two posts with different
 * sequence numbers differ on every axis.
 */
export function assignFeaturedVariation(args: { seq: number; topicText: string; recentScenes?: string[] }): FeaturedVariation {
  const { seq, topicText } = args;
  const recent = new Set((args.recentScenes ?? []).slice(0, 4));
  const allowed = FEATURED_SCENES.filter((s) => !s.fitOnly || s.fits?.test(topicText));
  const fresh = allowed.filter((s) => !recent.has(s.id));
  const pool = fresh.length ? fresh : allowed;
  const fitting = pool.filter((s) => s.fits?.test(topicText));
  // Half the time take a scene that suits the topic; otherwise any fresh one,
  // so a run of similar topics does not settle on the same two scenes.
  const candidates = fitting.length && seq % 2 === 0 ? fitting : pool;
  const scene = candidates[Math.abs(seq) % candidates.length];

  const place = detectPlace(topicText);
  const views = place === "other" ? null : PLACE_VIEWS[place];
  const view = scene.view === "none" || !views ? null : pick(views, seq, 3);

  return {
    seq,
    scene,
    camera: CAMERAS[pick(scene.cameras, seq, 1)],
    light: pick(LIGHTS, seq, 3),
    palette: pick(PALETTES, seq, 2),
    surface: pick(SURFACES, seq, 5),
    heroObject: pick(HERO_OBJECTS, seq, 4),
    authority: pick(AUTHORITY_PLACEMENTS, seq, 5),
    view,
    place,
  };
}

// ── Prompt text ────────────────────────────────────────────────

export const DETAIL_STANDARD = `THE DETAIL STANDARD (what the client's reference images have in common; every featured image must meet it):
1. Unmistakably THIS article: a reader scanning the blog library should guess the topic from the picture alone.
2. At least FOUR specific, real props from the subject, each named in the brief (a document by its real name, the asset, the equipment, the personal papers, the flags, the model, the screen content). No generic "papers" or "documents".
3. TWO to FOUR pieces of exact in-scene text, in quotation marks, taken from the article itself: the document's real title, the authority's name, a real step, deadline, figure or category the article discusses. Short (2 to 8 words each), spelled exactly, house spelling "license". Text only ever appears on real objects (covers, spines, letterheads, signs, screens, calendars, plaques), never as a caption, overlay, watermark or title card.
4. Layered depth: a sharp foreground, a working middle ground and a background that places the scene (the city, the building, the room).
5. Premium craft: rich but restrained colour, real materials (marble, leather, brass, glass, wood), motivated light, natural reflections. Photorealistic, never a cartoon, illustration or obvious 3D render. People, when present, are mid-task and never pose or smile at the camera; no real people's likenesses.
6. The brief is 90 to 150 words and ends with "photorealistic premium editorial photograph, 3:2".`;

/** The variation card, worded as instructions for the art director. */
export function formatVariationCard(v: FeaturedVariation): string {
  const viewLine = v.scene.view === "none"
    ? "View: none — this is a close detail shot; no skyline."
    : v.scene.view === "exterior"
      ? `View: the scene is OUTSIDE, in front of the authority's or free zone's real building${v.view ? `; ${v.view} may appear beyond` : ""}.`
      : v.view
        ? `View: if a window shows, it shows ${v.view}. Do not use the Burj Khalifa unless this line names it.`
        : "View: if a window shows, it shows a recognisable landmark of the jurisdiction the article is about, never a generic skyline.";
  return `VARIATION CARD FOR THIS POST'S FEATURED IMAGE (assigned by the editor so the blog library does not repeat itself; follow every line):
- Scene: ${v.scene.name} — ${v.scene.description}.
- Camera: ${v.camera}.
- Light: ${v.light}.
- Colour palette: ${v.palette} (the hero object and the accents take these colours; no cream or beige hero object unless the palette says ivory).
- Main surface: ${v.surface}.
- Hero object: ${v.heroObject}.
- Where the authority appears: ${v.authority}.
- ${viewLine}`;
}

/** One line for the dashboard: what this post's featured picture was assigned. */
export function describeVariation(v: FeaturedVariation): string {
  return [`#${v.seq}`, v.scene.name, v.light.split(",")[0], v.palette, v.surface, v.camera.replace(/ \(.*\)/, ""), v.view ?? "no named view"].join(" · ");
}

/** Everything the art director needs for the featured slot. */
export function featuredBriefBlock(v: FeaturedVariation): string {
  const example = v.scene.example;
  const others = FEATURED_SCENES.filter((s) => s.id !== v.scene.id).slice(0, 2);
  return `THE FEATURED IMAGE (hero) — briefed differently from the other three
${formatVariationCard(v)}

${DETAIL_STANDARD}

EXAMPLE OF THIS SCENE TYPE, at the level of detail required (article "${example.article}"; match its density, never copy its objects, place or wording):
${example.prompt}

For contrast, two other scene types used on other posts (do not drift towards them): ${others.map((s) => `${s.name.toLowerCase()} (${s.description})`).join("; ")}.`;
}

// ── Checks ─────────────────────────────────────────────────────

const quoted = (p: string) => p.match(/["“][^"”]{2,80}["”]/g) ?? [];

/** The first meaningful word of a card line, used to confirm the brief honoured it. */
const KEY_WORD: Record<string, RegExp> = {};
function keyFor(value: string): RegExp {
  if (!KEY_WORD[value]) {
    const word = value.toLowerCase().match(/[a-z]{4,}/g)?.find((w) => !["with", "light", "view", "lens", "close", "soft", "very", "clear", "crisp", "warm", "deep"].includes(w)) ?? value.toLowerCase();
    KEY_WORD[value] = new RegExp(`\\b${word.replace(/[^a-z]/g, "")}`, "i");
  }
  return KEY_WORD[value];
}

/**
 * Problems with a featured brief, in the same form as the diversity and
 * relevance reports (they share one revision round). Checks the detail bar,
 * the assigned card, and overlap with recent featured briefs.
 */
export function assessFeaturedPrompt(
  prompt: string,
  opts: { variation?: FeaturedVariation; recentPrompts?: string[]; label?: string } = {}
): string[] {
  const label = opts.label ?? "Hero (featured)";
  const p = prompt ?? "";
  const issues: string[] = [];
  const words = p.trim().split(/\s+/).filter(Boolean).length;

  if (quoted(p).length < 2) {
    issues.push(`${label} needs two to four pieces of exact in-scene text from the article, each in quotation marks.`);
  }
  if (words < 80) issues.push(`${label} is only ${words} words; the detail standard needs 90 to 150 to name the props and their text.`);

  const v = opts.variation;
  if (v) {
    if (!keyFor(v.palette).test(p)) issues.push(`${label} ignores its assigned palette (${v.palette}).`);
    if (!keyFor(v.light).test(p)) issues.push(`${label} ignores its assigned light (${v.light}).`);
    if (v.view && v.scene.view !== "none" && /burj khalifa/i.test(p) && !/burj khalifa/i.test(v.view)) {
      issues.push(`${label} uses the Burj Khalifa; its card assigns ${v.view}.`);
    }
    if (v.scene.view === "none" && /\bskyline\b/i.test(p)) issues.push(`${label} is a close detail shot and should not show a skyline.`);
  }

  for (const recent of opts.recentPrompts ?? []) {
    const sim = promptSimilarity(p, recent);
    if (sim >= 0.3) {
      issues.push(`${label} reads too much like a recent featured image (${Math.round(sim * 100)}% shared subject words); change the props, setting and wording as the card directs.`);
      break;
    }
  }
  return issues;
}
