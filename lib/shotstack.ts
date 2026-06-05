/**
 * lib/shotstack.ts
 * ─────────────────────────────────────────────────────────────
 * Shotstack video composition API.
 *
 * Sandbox (testing, watermarked, free):
 *   Base URL: https://api.shotstack.io/edit/stage
 * Production (credits consumed, clean output):
 *   Base URL: https://api.shotstack.io/edit/v1
 *
 * Switch by setting SHOTSTACK_ENV=production in env vars.
 * The API key is the same — Shotstack issues one key per environment
 * in the dashboard.
 */

const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY!;
const SHOTSTACK_BASE =
  process.env.SHOTSTACK_ENV === "production"
    ? "https://api.shotstack.io/edit/v1"
    : "https://api.shotstack.io/edit/stage";

// ── Types ──────────────────────────────────────────────────────

export interface VideoSegment {
  sectionTitle: string;  // short label shown as a title card (2–4 words)
  displayText: string;   // text shown on screen (1–2 sentences, ~35 words)
  durationSeconds: number;
  imageUrl: string;      // public URL for the background image
}

// ── API calls ──────────────────────────────────────────────────

/**
 * Submits a render job to Shotstack and returns the render ID.
 * Render is asynchronous — poll checkRenderStatus() until done.
 */
export async function submitShotstackRender(
  segments: VideoSegment[],
  audioUrl: string,
  logoUrl: string
): Promise<string> {
  const timeline = buildTimeline(segments, audioUrl, logoUrl);
  const body = {
    timeline,
    output: { format: "mp4", resolution: "hd", fps: 25 },
  };

  console.log("[shotstack] Submitting render to", SHOTSTACK_BASE);

  const res = await fetch(`${SHOTSTACK_BASE}/render`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SHOTSTACK_API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shotstack submit failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as { response: { id: string } };
  console.log("[shotstack] Render submitted, id:", data.response.id);
  return data.response.id;
}

/**
 * Polls the Shotstack render status.
 * status values: "queued" | "fetching" | "rendering" | "saving" | "done" | "failed"
 */
export async function checkRenderStatus(
  renderId: string
): Promise<{ status: string; url?: string; error?: string }> {
  const res = await fetch(`${SHOTSTACK_BASE}/render/${renderId}`, {
    headers: { "x-api-key": SHOTSTACK_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Shotstack status check failed: ${res.status}`);

  const data = (await res.json()) as {
    response: { status: string; url?: string; error?: string };
  };
  return {
    status: data.response.status,
    url: data.response.url,
    error: data.response.error,
  };
}

// ── Timeline builder ───────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Splits text roughly in half at a sentence or word boundary */
function splitText(text: string): [string, string] {
  const words = text.split(" ");
  const mid   = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

/** Subtitle bar HTML — full 1280px wide navy bar at the bottom */
function subtitleHtml(text: string, highlight = false): string {
  const bg    = highlight ? "rgba(27,42,74,0.95)" : "rgba(10,18,34,0.88)";
  const border = highlight ? "3px solid #C9A84C" : "3px solid rgba(201,168,76,0.4)";
  return `<div style="width:1280px;height:120px;background:${bg};border-top:${border};display:flex;align-items:center;justify-content:center;padding:0 60px;box-sizing:border-box;"><p style="font-family:Georgia,serif;color:#ffffff;font-size:26px;line-height:1.5;margin:0;text-align:center;text-decoration:none;">${escHtml(text)}</p></div>`;
}

/** Full-screen section title card HTML (1280×720) */
function sectionCardHtml(title: string, index: number): string {
  const num = String(index + 1).padStart(2, "0");
  return `<div style="width:1280px;height:720px;background:#0f1a2e;display:flex;flex-direction:column;align-items:center;justify-content:center;"><div style="width:48px;height:3px;background:#C9A84C;margin-bottom:28px;"></div><p style="font-family:Georgia,serif;color:#C9A84C;font-size:13px;text-transform:uppercase;letter-spacing:5px;margin:0 0 20px;text-decoration:none;">${escHtml(num)}</p><p style="font-family:Georgia,serif;color:#ffffff;font-size:38px;margin:0;text-align:center;max-width:700px;line-height:1.3;text-decoration:none;">${escHtml(title)}</p><div style="width:48px;height:3px;background:#C9A84C;margin-top:28px;"></div></div>`;
}

function buildTimeline(
  segments: VideoSegment[],
  audioUrl: string,
  logoUrl: string
): object {
  let time = 0;

  // All clips go into a single track per layer type
  const bgClips:    object[] = [];
  const cardClips:  object[] = []; // full-screen section title cards
  const subClips:   object[] = []; // subtitle text bars
  const logoClips:  object[] = [];
  const audioClips: object[] = [];

  const CARD_DUR = 2.5; // seconds for full-screen section title card

  for (let i = 0; i < segments.length; i++) {
    const seg    = segments[i];
    const dur    = seg.durationSeconds;
    const effect = i % 2 === 0 ? "zoomIn" : "zoomOut";

    // ── Full-screen section title card ─────────────────────────────────
    // Covers the first CARD_DUR seconds of each scene.
    // The background image runs behind it the whole time.
    bgClips.push({
      asset: { type: "image", src: seg.imageUrl },
      start: time,
      length: dur,
      effect,
      opacity: 0.5,
      transition: { in: "fade", out: "fade" },
    });

    cardClips.push({
      asset: {
        type: "html",
        html: sectionCardHtml(seg.sectionTitle, i),
        width: 1280,
        height: 720,
      },
      start: time,
      length: CARD_DUR,
      position: "center",
      transition: { in: "fade", out: "fade" },
    });

    // ── Progressive subtitle reveal ────────────────────────────────────
    // Split display text into two halves — first half appears after the
    // title card fades, second half at the mid-point of the scene.
    // This creates a progressive "building" text effect that's achievable
    // with Shotstack's static HTML rendering (no JS animations needed).
    const contentDur  = dur - CARD_DUR;
    const contentStart = time + CARD_DUR;
    const [first, second] = splitText(seg.displayText);

    subClips.push({
      asset: { type: "html", html: subtitleHtml(first), width: 1280, height: 120 },
      start: contentStart,
      length: contentDur * 0.5,
      position: "bottom",
      transition: { in: "fade", out: "fade" },
    });

    if (second.trim()) {
      subClips.push({
        asset: { type: "html", html: subtitleHtml(second, true), width: 1280, height: 120 },
        start: contentStart + contentDur * 0.5,
        length: contentDur * 0.5,
        position: "bottom",
        transition: { in: "fade", out: "fade" },
      });
    }

    time += dur;
  }

  const totalDuration = time;

  // ── Logo watermark ─────────────────────────────────────────────────
  logoClips.push({
    asset: { type: "image", src: logoUrl },
    start: 0,
    length: totalDuration,
    position: "bottomRight",
    offset: { x: -0.02, y: -0.02 },
    scale: 0.12,
    opacity: 0.85,
  });

  // ── Full-screen CTA end card (last 12 seconds) ─────────────────────
  const ctaStart = Math.max(0, totalDuration - 12);
  const ctaHtml  = `<div style="width:1280px;height:720px;background:#0f1a2e;display:flex;flex-direction:column;align-items:center;justify-content:center;"><div style="width:80px;height:3px;background:#C9A84C;margin-bottom:32px;"></div><p style="font-family:Georgia,serif;color:#C9A84C;font-size:13px;text-transform:uppercase;letter-spacing:6px;margin:0 0 24px;text-decoration:none;">Corporate Advisory</p><p style="font-family:Georgia,serif;color:#ffffff;font-size:52px;margin:0 0 12px;text-decoration:none;">aston.ae</p><p style="font-family:Georgia,serif;color:rgba(255,255,255,0.55);font-size:20px;margin:0;text-decoration:none;">Speak with our advisers today</p><div style="width:80px;height:3px;background:#C9A84C;margin-top:32px;"></div></div>`;

  cardClips.push({
    asset: { type: "html", html: ctaHtml, width: 1280, height: 720 },
    start: ctaStart,
    length: 12,
    position: "center",
    transition: { in: "fade", out: "fade" },
  });

  // ── Narration audio ────────────────────────────────────────────────
  audioClips.push({
    asset: { type: "audio", src: audioUrl, volume: 1.0 },
    start: 0,
    length: totalDuration,
  });

  // Background music:
  //   Production — defaults to Shotstack's own hosted asset (always accessible
  //                on paid plans). Override with SHOTSTACK_MUSIC_URL if needed.
  //   Sandbox    — excluded by default (third-party CDNs block sandbox requests).
  //                Set SHOTSTACK_MUSIC_URL to a WordPress media URL to test music.
  const isProduction = process.env.SHOTSTACK_ENV === "production";
  const musicUrl =
    process.env.SHOTSTACK_MUSIC_URL?.trim() ||
    (isProduction
      ? "https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/unminus/ambisonic.mp3"
      : "");
  const soundtrack = musicUrl
    ? { src: musicUrl, effect: "fadeOut", volume: 0.1 }
    : undefined;

  return {
    ...(soundtrack ? { soundtrack } : {}),
    background: "#000000",
    // Track order: index 0 = topmost layer
    tracks: [
      { clips: logoClips  },  // 0 — logo watermark (always on top)
      { clips: cardClips  },  // 1 — full-screen section cards + CTA
      { clips: subClips   },  // 2 — subtitle text bars
      { clips: bgClips    },  // 3 — background images (darkened via opacity)
      { clips: audioClips },  // 4 — narration audio
    ],
  };
}
