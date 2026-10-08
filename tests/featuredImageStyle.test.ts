import { describe, it, expect } from "vitest";
import {
  FEATURED_SCENES, assignFeaturedVariation, assessFeaturedPrompt, featuredBriefBlock, formatVariationCard, detectPlace,
} from "@/lib/featuredImageStyle";

// The eight posts from 2026-10-06 whose featured images were near-identical
// in the blog library (cream book, Burj Khalifa window, "Central Bank of the UAE").
const BATCH = [
  "UAE bank account for high-risk businesses",
  "Opening a UAE bank account for a foreign-owned company",
  "UAE business bank account rejected: what to do next",
  "Best banks in Dubai for business accounts",
  "UAE corporate bank account for non-residents",
  "Opening a corporate bank account in Dubai",
  "Moving a business to Dubai for tax purposes",
  "UAE corporate tax for international businesses",
];

function runBatch(startSeq: number) {
  const recentScenes: string[] = [];
  return BATCH.map((title, i) => {
    const v = assignFeaturedVariation({ seq: startSeq + i, topicText: title, recentScenes: [...recentScenes] });
    recentScenes.unshift(v.scene.id);
    return v;
  });
}

describe("featured variation cards across posts", () => {
  it("never repeats a scene within four consecutive posts", () => {
    const cards = runBatch(101);
    for (let i = 0; i < cards.length; i++) {
      const window = cards.slice(Math.max(0, i - 4), i).map((c) => c.scene.id);
      expect(window).not.toContain(cards[i].scene.id);
    }
  });

  it("changes light, palette and surface between consecutive posts", () => {
    const cards = runBatch(7);
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].light).not.toBe(cards[i - 1].light);
      expect(cards[i].palette).not.toBe(cards[i - 1].palette);
      expect(cards[i].surface).not.toBe(cards[i - 1].surface);
    }
  });

  it("uses at least five different scenes and views for the 6 October batch", () => {
    const cards = runBatch(40);
    expect(new Set(cards.map((c) => c.scene.id)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(cards.map((c) => c.view)).size).toBeGreaterThanOrEqual(4);
    expect(cards.filter((c) => /burj khalifa/i.test(c.view ?? "")).length).toBeLessThanOrEqual(2);
  });

  it("still differs when a batch is generated at once (same history, consecutive sequence numbers)", () => {
    const cards = BATCH.map((title, i) => assignFeaturedVariation({ seq: 200 + i, topicText: title, recentScenes: ["handover", "macro"] }));
    const pairsAlike = cards.flatMap((a, i) => cards.slice(i + 1).map((b) => a.scene.id === b.scene.id && a.light === b.light && a.palette === b.palette));
    expect(pairsAlike.some(Boolean)).toBe(false);
  });

  it("keeps the comparison scene for articles that compare options", () => {
    const scenes = Array.from({ length: 30 }, (_, i) => assignFeaturedVariation({ seq: i, topicText: "UAE business bank account rejected: what to do next" }).scene.id);
    expect(scenes).not.toContain("comparison");
    const vs = Array.from({ length: 30 }, (_, i) => assignFeaturedVariation({ seq: i, topicText: "Dubai vs Panama company setup" }).scene.id);
    expect(vs).toContain("comparison");
  });

  it("picks the right place's landmarks", () => {
    expect(detectPlace("ADGM foundation setup")).toBe("abu_dhabi");
    expect(detectPlace("DIFC category 3A license")).toBe("difc");
    expect(detectPlace("DMCC gold trading license")).toBe("dmcc");
    expect(detectPlace("Opening a corporate bank account in Dubai")).toBe("dubai");
    expect(detectPlace("Buying a MiFID investment firm in Europe")).toBe("other");
  });
});

describe("featured brief checks", () => {
  it("every scene's worked example meets the detail standard", () => {
    for (const s of FEATURED_SCENES) expect(assessFeaturedPrompt(s.example.prompt), s.id).toEqual([]);
  });

  it("sends back a brief that ignores its card", () => {
    const v = assignFeaturedVariation({ seq: 3, topicText: "Opening a corporate bank account in Dubai" });
    const generic = `Medium view at seated eye level in a premium Dubai office with floor-to-ceiling windows onto the Burj Khalifa in bright daylight. On a polished desk in the sharp foreground: a cream hardcover dossier titled "Dubai Corporate Bank Account Opening" with "Application Dossier" beneath, a tablet showing a checklist, a black card reader and a fountain pen. Behind, the words "Central Bank of the UAE" in brushed gold on a dark wall. Shallow depth of field, photorealistic premium editorial photograph, 3:2.`;
    const issues = assessFeaturedPrompt(generic, { variation: { ...v, palette: "burgundy leather and brass", light: "blue hour at dusk, city lights coming on, warm lamps inside", view: "Dubai Creek with wooden dhows and the Deira waterfront" } });
    expect(issues.join(" ")).toMatch(/palette/);
    expect(issues.join(" ")).toMatch(/light/);
    expect(issues.join(" ")).toMatch(/Burj Khalifa/);
  });

  it("flags a brief that reads like a recent featured image", () => {
    const recent = FEATURED_SCENES[0].example.prompt;
    const issues = assessFeaturedPrompt(recent.replace("Gold Trading License Application", "Gold Trading License Renewal"), { recentPrompts: [recent] });
    expect(issues.join(" ")).toMatch(/recent featured image/);
  });

  it("shows the card, the detail standard and one example of the assigned scene", () => {
    const v = assignFeaturedVariation({ seq: 12, topicText: "Who now qualifies for a Dubai property visa" });
    const block = featuredBriefBlock(v);
    expect(block).toContain(formatVariationCard(v));
    expect(block).toMatch(/DETAIL STANDARD/);
    expect(block).toContain(v.scene.example.prompt);
  });
});
