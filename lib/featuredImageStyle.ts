/**
 * lib/featuredImageStyle.ts
 * ─────────────────────────────────────────────────────────────
 * The Aston VIP "signature" look for FEATURED (hero) images only. Pure text,
 * no imports, so any prompt builder can use it.
 *
 * Source: 17 featured images the client chose as the target style
 * (assets/image-references/ in the main checkout, 2026-10-05). They are
 * remarkably consistent, and deliberately so — the featured image is the
 * brand's face in listings and link previews:
 *
 *  - a premium high-floor advisory office or lounge, floor-to-ceiling glass,
 *    and through it the jurisdiction's unmistakable skyline (Burj Khalifa,
 *    the DIFC Gate, Al Maryah Island's towers and waterfront);
 *  - in the sharp foreground, on dark veined marble, walnut or glass, a
 *    hardcover dossier or binder whose gold-foil title names the exact
 *    subject ("ADGM Crypto License — Application Dossier", "UAE Corporate
 *    Tax 2026"), with one to three props that prove the topic: gold bars for
 *    a gold-trading article, a passport and Emirates ID for a residency visa,
 *    a card terminal for a payment license, a custody safe for crypto, a desk
 *    calendar showing the filing deadline, flags of the two jurisdictions
 *    being compared, an architectural model for real estate;
 *  - the authority itself named in the scene: brushed-gold lettering on a
 *    dark wall ("VARA — Virtual Assets Regulatory Authority", "DMCC") or its
 *    building seen through the window;
 *  - often a stack of hardback reference books with gold spine titles and an
 *    Aston VIP mark on a folder, mug or plaque;
 *  - people in about a third of them: an adviser and a client (often an
 *    Emirati client in a kandura) reviewing the dossier, a man in a dark suit
 *    seen from behind at the window, or just hands holding the documents;
 *  - navy, black, charcoal, ivory and warm gold; golden-hour or bright late
 *    morning light; shallow depth of field, photorealistic, 3:2 landscape.
 *
 * In September the client complained that ALL FOUR images on a post looked
 * like this (lib/imageBrief.ts history). The resolution is that the featured
 * image owns this look and the three in-article images do not repeat it.
 */

export const FEATURED_STYLE_GUIDE = `THE FEATURED IMAGE — ASTON VIP SIGNATURE STYLE (the client's chosen look; follow it closely)
The featured image is the brand's face in listings and link previews. Unlike the other three pictures it follows one consistent, recognisable formula, varied only by the article's subject:

1. SETTING: a premium, high-floor advisory office or private lounge with floor-to-ceiling windows. Through the glass, the skyline of the jurisdiction the article is about, unmistakable at a glance: Dubai and DMCC → the Burj Khalifa and Downtown towers; DIFC → The Gate building with the Burj Khalifa behind; ADGM / Abu Dhabi → the Al Maryah Island towers and waterfront promenade; another country → its own recognisable skyline or landmark. The office itself is understated luxury: dark veined marble, walnut, glass, brass, leather, a plant or a vase of white flowers.
2. HERO OBJECT (sharp, lower half of the frame, on a polished desk or table): a hardcover dossier, binder or presentation folder in navy, black or ivory whose gold-foil cover title names the article's exact subject in 2 to 6 words, often with a small subtitle such as "Application Dossier", "Tax Return Filing Dossier" or "Eligibility Review".
3. TOPIC PROPS (one to three, chosen so the subject is obvious without reading): gold bars (gold trading, DMCC commodities, tokenised assets), a UAE passport and Emirates ID card (visas, residency), a card payment terminal (payment and EMI licenses), a compact secure custody safe or a hardware wallet (crypto custody), a desk calendar showing the real deadline date (tax and filing deadlines), small table flags of each jurisdiction (comparisons), an architectural scale model (real estate, tokenisation), a laptop or tablet showing a simple flowchart or decision tree about the topic (process and route-choice articles), a fountain pen, a crystal water glass.
4. THE AUTHORITY, NAMED: the regulator, free zone or authority the article is about appears in the scene, either as brushed-gold or silver lettering on a dark marble or wood wall panel (e.g. "VARA" with "Virtual Assets Regulatory Authority" beneath, "DMCC", "DIFC" with "Dubai International Financial Centre", "Central Bank of the UAE") or as its real building seen through the window.
5. OPTIONAL SUPPORTING DETAILS (use one or two, not all): a stack of three or four dark hardback reference books with gold spine titles naming related subjects ("UAE Corporate Law", "Fund Structures", "Regulatory Compliance"); the Aston VIP name in small gold lettering on a folder, mug or desk plaque; a short checklist on a clipboard listing three to six real steps from the article.
6. PEOPLE (optional, in roughly one featured image in three): an adviser in a dark suit and a client, who may be an Emirati man in a white kandura and ghutra, reviewing the dossier together; or one professional in a dark suit seen from behind or over the shoulder looking out at the skyline; or just a pair of hands holding the documents. Natural, mid-task, never posing or smiling at the camera.
7. LIGHT AND FINISH: warm golden-hour or bright late-morning daylight from the windows, soft reflections on the polished surfaces, rich but restrained colour (navy, black, charcoal, ivory, warm gold). Camera at seated eye level, 35mm, shallow depth of field: the foreground objects pin-sharp, the skyline slightly soft. Photorealistic premium editorial and advertising photography, 3:2 landscape. Never a cartoon, illustration or obvious 3D render; translucent network lines on the glass only for crypto or tokenisation subjects, and subtly.
8. TEXT IN THE IMAGE is wanted here and must be exact: write every piece of in-scene text in the prompt in quotation marks, spelled exactly as it should appear, short (2 to 8 words each), at most five text items in the frame, house spelling "license". Never captions, overlays, watermarks or title cards: text only on real objects (covers, spines, signs, screens, calendars).
9. VARY BETWEEN POSTS through the subject, never the formula: a different hero object and cover title, different props, the right authority and skyline, a different material (marble, walnut, glass, travertine) and time of day than recent featured images.
10. THE PROMPT is 90 to 150 words: the setting and skyline, the hero object and its exact cover text, the props, the authority signage text, any people, the light and the camera, ending with "photorealistic premium editorial photograph, 3:2".`;

/**
 * Example briefs written from the client's reference images. Shown to the
 * art director as the standard to match (not to copy word for word).
 */
export const FEATURED_EXAMPLES: Array<{ article: string; prompt: string }> = [
  {
    article: "What an ADGM crypto license really involves",
    prompt: `View from inside a high-floor advisory office on Al Maryah Island, Abu Dhabi, through floor-to-ceiling glass to the ADGM building, its "ADGM" lettering on the facade, the waterfront promenade and palm trees beyond in late-afternoon sun. On a polished dark walnut desk in the sharp foreground: a navy hardcover binder with a gold-foil sunburst emblem and the title "ADGM Crypto License", subtitle "Application Dossier", beside a black-and-gold fountain pen; behind it a brass desk plaque reading "Financial Services Permission" and a compact matte black safe labelled "Secure Custody". Warm golden light, soft reflections, 35mm at seated eye level, shallow depth of field, photorealistic premium editorial photograph, 3:2.`,
  },
  {
    article: "When your UAE Corporate Tax return is actually due",
    prompt: `A premium executive desk by floor-to-ceiling windows high above Downtown Dubai, the Burj Khalifa soft in the background in warm morning light. Sharp in the foreground on dark leather and walnut: a navy leather-bound folder with gold-foil lettering "UAE Corporate Tax return 2026", a printed return form under a black fountain pen, a desk calendar showing "September 2026" and a large "30", an open laptop on a tax portal login page, and three dark hardback books with gold spines reading "VAT", "UAE Corporate Tax" and "Finance Act". Rich navy, black and gold palette, shallow depth of field, 35mm at seated eye level, photorealistic premium editorial photograph, 3:2.`,
  },
  {
    article: "Who now qualifies for a Dubai property visa",
    prompt: `A bright luxury residence lounge high in Downtown Dubai, floor-to-ceiling windows framing the Burj Khalifa in clear late-morning light, a cream sofa and a gold vase of white blossom softly out of focus. On a white-and-grey veined marble table in the sharp foreground: a navy UAE passport with the gold national emblem, an Emirates ID card in a taupe leather card holder, and an ivory document folder titled "Dubai Property" with the subtitle "Visa Application" and a skyline photograph on its cover, a black-and-gold pen resting on it. Soft warm reflections, shallow depth of field, 35mm, photorealistic premium editorial photograph, 3:2.`,
  },
  {
    article: "Dubai vs Panama company setup beyond the headlines",
    prompt: `A dark, refined boardroom with a vintage world map on the wall and a window onto a hazy waterfront skyline. On the long charcoal table, side by side in the sharp foreground: a navy leather folder titled in gold "Dubai free zone company" and a stone-grey folder titled "Panama offshore company", a small UAE table flag on the left and a Panama table flag on the right on brass stands, and behind each folder a detailed architectural scale model, Dubai's towers on one side and the Panama Canal waterfront on the other. Warm interior lighting, rich browns and gold, shallow depth of field, photorealistic premium editorial photograph, 3:2.`,
  },
  {
    article: "DMCC gold trading license",
    prompt: `A luxury DMCC advisory office with floor-to-ceiling windows over the Dubai skyline in bright midday light. On the dark wall to the right, large brushed-gold letters "DMCC" with "Dubai Multi Commodities Centre" beneath. At a dark marble table an adviser in a navy suit and an Emirati client in a white kandura and ghutra review a printed trade document together, a pen in the adviser's hand; in the sharp foreground, stacked gold bullion bars and small gold ingots in black presentation trays beside a closed black leather portfolio. Natural, mid-conversation, nobody looking at the camera, shallow depth of field, photorealistic premium editorial photograph, 3:2.`,
  },
];

/** The style guide plus the worked examples, ready to drop into a prompt. */
export function featuredStyleBlock(): string {
  const examples = FEATURED_EXAMPLES
    .map((e, i) => `Example ${i + 1}: article "${e.article}"\n${e.prompt}`)
    .join("\n\n");
  return `${FEATURED_STYLE_GUIDE}\n\nEXAMPLE FEATURED BRIEFS (the standard to match for detail, composition and exact in-scene text; never copy one, build yours from this article's subject):\n\n${examples}`;
}

/**
 * Does a featured brief follow the signature formula? Returns problems in the
 * same form as the diversity/relevance reports, so they feed the one revision
 * round. Deliberately loose: it checks the formula's load-bearing parts, not
 * taste.
 */
export function assessFeaturedPrompt(prompt: string, label = "Hero (featured)"): string[] {
  const p = prompt ?? "";
  const issues: string[] = [];
  const words = p.trim().split(/\s+/).filter(Boolean).length;
  if (!/\b(window|windows|glass|skyline)\b/i.test(p)) {
    issues.push(`${label} does not follow the signature style: put the jurisdiction's skyline behind floor-to-ceiling glass.`);
  }
  if (!/\b(dossier|binder|folder|portfolio|report|document|documents|file)\b/i.test(p)) {
    issues.push(`${label} does not follow the signature style: give it a hero dossier, binder or folder in the sharp foreground.`);
  }
  if (!/["“][^"”]{2,}["”]/.test(p)) {
    issues.push(`${label} does not follow the signature style: write the exact cover title and authority lettering in quotation marks.`);
  }
  if (words < 70) issues.push(`${label} is only ${words} words; the signature brief needs 90 to 150 to pin down the objects and their text.`);
  return issues;
}
