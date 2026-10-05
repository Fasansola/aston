import { describe, it, expect } from "vitest";
import { stagedImageKey } from "@/lib/stagedImages";

describe("stagedImageKey", () => {
  it("reuses a staged image only for the same brief and model", () => {
    const a = stagedImageKey(71682, "featured", "A Paris advisory lounge…", "gpt-image-2");
    expect(stagedImageKey(71682, "featured", "  A Paris advisory lounge…\n", "gpt-image-2")).toBe(a);
    expect(stagedImageKey(71682, "featured", "A different brief", "gpt-image-2")).not.toBe(a);
    expect(stagedImageKey(71682, "featured", "A Paris advisory lounge…", "imagen-4")).not.toBe(a);
    expect(a).toMatch(/^article-images\/71682\/featured-[0-9a-f]{16}\.png$/);
  });

  it("never matches the old post-and-slot key that served stale images", () => {
    expect(stagedImageKey(71682, "kp1", "x", "gpt-image-2")).not.toBe("article-images/71682/kp1.png");
  });
});
