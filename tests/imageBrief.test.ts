import { describe, it, expect } from "vitest";
import {
  htmlToText, extractHeadings, sectionOutline, articleOutline, buildImageBriefs,
  formatImageBriefs, assessPromptDiversity, conceptsFromPrompts, formatSceneBriefs,
} from "@/lib/imageBrief";

const article = {
  focus_keyword: "ADGM crypto license",
  secondary_keywords: ["FSRA permission", "virtual asset custody"],
  key_takeaways: "<ul><li>ADGM crypto license approval depends on activity classification.</li><li>Banking requires source of wealth evidence.</li></ul>",
  main_content: "<p>An ADGM crypto license is not the same as incorporating a company.</p><h3>Why activity classification matters</h3><p>The FSRA perimeter decides everything. Incorporation alone never authorises regulated services.</p>",
  keypoint_one: "An ADGM company is only the legal vehicle, not the permission to operate.",
  more_content_1: "<h3>Do you need an ADGM crypto license</h3><p>The first question is whether the activity falls inside the FSRA perimeter.</p>",
  more_content_2: "<h3>ADGM crypto license costs and capital</h3><p>Company and registration costs come first.</p>",
  quote_1: "Classify the activity before you incorporate.",
  more_content_3: "<h3>FSRA virtual assets and activities</h3><h4>Accepted virtual assets</h4><p>Only accepted tokens can be traded.</p>",
  keypoint_two: "Tokenisation is not merely a technology question. The underlying asset may convert the project into securities.",
  more_content_4: "<h3>Aston VIP&#8217;s role in your ADGM crypto license</h3><p>Aston VIP reviews the activity perimeter before incorporation or filing.</p>",
  quote_2: "Build the regulatory file before the company.",
  more_content_5: "<h3>How do I get a crypto license in ADGM?</h3><p>Secure FSRA permission.</p><h3>What is an FSRA license in ADGM?</h3><p>It is a permission.</p>",
  more_content_6: "<h3>ADGM crypto license versus Dubai VARA</h3><p>They regulate different markets.</p>",
  final_points: "<ul><li>Classify each activity before choosing ADGM, VARA or DIFC.</li></ul>",
};

describe("html helpers", () => {
  it("strips tags, decodes entities and cuts on a word boundary", () => {
    expect(htmlToText("<p>Aston VIP&#8217;s <b>role</b> &amp; scope</p>")).toBe("Aston VIP’s role & scope");
    const cut = htmlToText("<p>one two three four five six seven</p>", 14);
    expect(cut).toBe("one two three…");
  });

  it("extracts headings in order and builds a section outline", () => {
    expect(extractHeadings(article.more_content_3)).toEqual(["FSRA virtual assets and activities", "Accepted virtual assets"]);
    const outline = sectionOutline(article.more_content_1);
    expect(outline).toContain("Headings: Do you need an ADGM crypto license.");
    expect(outline).toContain("Opens: \"The first question");
    expect(sectionOutline("")).toBe("");
  });

  it("lists every heading across the article in page order", () => {
    const outline = articleOutline(article);
    expect(outline[0]).toBe("Why activity classification matters");
    expect(outline[outline.length - 1]).toBe("ADGM crypto license versus Dubai VARA");
  });
});

describe("buildImageBriefs", () => {
  const briefs = buildImageBriefs("When your firm needs an ADGM crypto license in 2026", article);

  it("produces the four slots in page order", () => {
    expect(briefs.map((b) => b.slot)).toEqual(["featured", "keypoint_one", "post_split", "keypoint_two"]);
  });

  it("anchors each picture to the text that sits beside it on the page", () => {
    const [featured, kp1, split, kp2] = briefs;
    expect(featured.anchorText).toContain("Key takeaways: ADGM crypto license approval");
    expect(kp1.anchorText).toBe("An ADGM company is only the legal vehicle, not the permission to operate.");
    expect(kp1.after).toContain("Do you need an ADGM crypto license");
    expect(split.anchorText).toContain("Closing quote beside it: \"Build the regulatory file before the company.\"");
    expect(split.anchorText).toContain("Aston VIP’s role in your ADGM crypto license");
    expect(split.after).toContain("How do I get a crypto license in ADGM?");
    expect(kp2.anchorText).toContain("Tokenisation is not merely a technology question");
    expect(kp2.before).toContain("FSRA virtual assets and activities");
    expect(kp2.after).toContain("Final points: Classify each activity");
    expect(kp2.after).toContain("ADGM crypto license versus Dubai VARA");
  });

  it("falls back to the surrounding section when a pull-out sentence is missing", () => {
    const [, kp1] = buildImageBriefs("t", { ...article, keypoint_one: "" });
    expect(kp1.anchorText).toContain("An ADGM crypto license is not the same as incorporating a company.");
  });

  it("renders a readable block for the model", () => {
    const text = formatImageBriefs(briefs);
    expect(text).toContain("1) featured");
    expect(text).toContain("4) keypoint_two");
    expect(text).toContain("Text beside it");
  });
});

describe("assessPromptDiversity", () => {
  it("flags the binder-on-a-desk-with-a-skyline set the site kept producing", () => {
    const report = assessPromptDiversity([
      "A leather binder embossed ADGM crypto license on a polished boardroom table, floor-to-ceiling windows with the Al Maryah Island skyline behind, shot on Canon EOS R5 85mm f/1.4, shallow depth of field, warm natural light, no text overlay",
      "Navy application dossier and FSRA nameplate on a dark wood desk in front of a window showing the Abu Dhabi skyline, shot on Canon EOS R5 85mm f/1.4, shallow depth of field, warm natural light, no text overlay",
      "Two men in suits reviewing a bound report at a conference table in a modern office with a city view, shot on Canon EOS R5 85mm f/1.4, warm light, no text overlay",
      "Two businessmen at a boardroom table with binders labelled custody and tokenised securities, office windows and towers behind, shot on Canon EOS R5 85mm f/1.4, warm light, no text overlay",
    ]);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => /documents-on-a-desk/.test(i))).toBe(true);
    expect(report.issues.some((i) => /office interiors/.test(i))).toBe(true);
    expect(report.issues.some((i) => /two people at a table/.test(i))).toBe(true);
  });

  it("passes four genuinely different pictures", () => {
    const report = assessPromptDiversity([
      "Wide view along the Al Maryah Island waterfront promenade at dawn, ADGM Square towers reflected in still water, a lone jogger for scale, cool blue light, 24mm lens, no readable text anywhere in the frame, photorealistic editorial photograph",
      "Close-up of a hardware wallet and a bank security token resting on a slate tile beside a brass key, raking afternoon light, macro lens, no readable text anywhere in the frame, photorealistic editorial photograph",
      "A compliance officer in a grey cardigan pins a printed licensing timeline along a studio wall, candid mid-task, overhead daylight, medium shot 35mm, no readable text anywhere in the frame, photorealistic editorial photograph",
      "A quiet marble corridor forking into three lit doorways, a single figure pausing at the junction, late evening warm lamps, wide 28mm lens, no readable text anywhere in the frame, photorealistic editorial photograph",
    ]);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("does not mistake signing, signatures or design for signage", () => {
    const report = assessPromptDiversity([
      "A hardware signing device in a custody cage, close macro, no readable text anywhere in the frame",
      "A director rehearsing a dual-authorisation signature procedure with the compliance lead, candid medium shot, no readable text",
      "A designer's architectural model of stacked floors on a workbench, wide shot, no readable text",
      "A sunlit harbour town seen from the water, dawn, no readable text",
    ]);
    expect(report.issues.filter((i) => /legible in-scene text/.test(i))).toEqual([]);
  });

  it("limits legible in-scene text to one image", () => {
    const report = assessPromptDiversity([
      "A brass nameplate engraved FSRA on a granite plinth outside a registry building, morning light, medium shot",
      "A stamped certificate of incorporation, embossed seal catching the light, close macro shot",
      "A courier crossing a sunlit customs yard carrying a sealed envelope, wide shot",
      "Stacked glass floors of an atrium seen from below, cool daylight, wide lens",
    ]);
    expect(report.issues.some((i) => /legible in-scene text/.test(i))).toBe(true);
  });
});

describe("conceptsFromPrompts", () => {
  it("collects only the concept fields that are present", () => {
    expect(conceptsFromPrompts({ featured_img_concept: " The perimeter test ", keypoint_two_img_concept: "" })).toEqual({ featured: "The perimeter test" });
    expect(conceptsFromPrompts({})).toBeUndefined();
    expect(conceptsFromPrompts(null)).toBeUndefined();
  });
});

describe("assessPromptDiversity for video scenes", () => {
  const deskScene = (n: number) => `A photograph of an adviser and client at a desk in a Dubai office, laptop open between them, skyline window behind, variant ${n}, 50mm lens`;

  it("applies video limits: two offices allowed, screens once, no signage", () => {
    const report = assessPromptDiversity([
      deskScene(1), deskScene(2), deskScene(3),
      "A photograph of a brass nameplate reading VARA on a marble plinth, morning light",
      "A photograph of a founder at a registry service counter handing over a folder, candid, 35mm",
      "A photograph of a customs yard at dawn, containers stacked, wide 24mm",
      "A photograph of a stamped share certificate on a slate tile, macro",
    ], undefined, { maxOffices: 2, maxDuos: 2, maxSignage: 0, maxScreens: 1 });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => /office interiors/.test(i))).toBe(true);
    expect(report.issues.some((i) => /laptop, monitor or dashboard/.test(i))).toBe(true);
    expect(report.issues.some((i) => /legible in-scene text/.test(i))).toBe(true);
  });

  it("ignores negated mentions such as 'no readable text' and 'no laptops'", () => {
    const report = assessPromptDiversity([
      "A photograph of a founder walking through a free-zone registry hall, no readable text anywhere in the frame, no signs or logos",
      "A photograph of a bound ledger on a workbench, no laptops or screens, no readable text anywhere in the frame",
    ], undefined, { maxSignage: 0, maxScreens: 0 });
    expect(report.issues).toEqual([]);
  });
});

describe("formatSceneBriefs", () => {
  it("lists each scene with its narration and on-screen text", () => {
    const text = formatSceneBriefs([
      { sectionTitle: "Introduction", narration: "Dubai has fifty six licensed crypto firms.", displayText: "Fifty six firms hold a license.", bullets: ["Check the VARA register", "Classify your activity"] },
      { sectionTitle: "Costs", narration: "Budget for capital and fees." },
    ]);
    expect(text).toContain("Scene 1 — \"Introduction\"");
    expect(text).toContain("Narration heard while this image is on screen: \"Dubai has fifty six licensed crypto firms.\"");
    expect(text).toContain("On-screen bullets: Check the VARA register / Classify your activity");
    expect(text).toContain("Scene 2 — \"Costs\"");
    expect(text).not.toContain("Scene 2 — \"Costs\"\n   On-screen sentence");
  });
});
