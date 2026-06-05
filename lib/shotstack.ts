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

function buildTimeline(
  segments: VideoSegment[],
  audioUrl: string,
  logoUrl: string
): object {
  let time = 0;

  const bgClips:    object[] = [];
  const overlayClips: object[] = [];
  const titleClips:  object[] = [];
  const textClips:   object[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = seg.durationSeconds;

    // ── Background image — alternating zoomIn / zoomOut (Ken Burns) ──
    bgClips.push({
      asset: { type: "image", src: seg.imageUrl },
      start: time,
      length: dur,
      effect: i % 2 === 0 ? "zoomIn" : "zoomOut",
      transition: { in: "fade", out: "fade" },
    });

    // ── Dark overlay (55% opacity black) ─────────────────────────────
    overlayClips.push({
      asset: {
        type: "html",
        html: "<div style='background:#000000;width:1280px;height:720px;'></div>",
        width: 1280,
        height: 720,
      },
      start: time,
      length: dur,
      opacity: 0.55,
    });

    // ── Section title card (slides in from left for first 2.5 s) ─────
    titleClips.push({
      asset: {
        type: "html",
        html: `<div style="display:inline-flex;align-items:center;padding:12px 24px;background:rgba(27,42,74,0.92);border-left:4px solid #C9A84C;"><span style="font-family:Georgia,serif;color:#C9A84C;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:3px;">${escHtml(seg.sectionTitle)}</span></div>`,
        width: 700,
        height: 56,
      },
      start: time,
      length: 2.5,
      position: "topLeft",
      offset: { x: 0.04, y: -0.38 },
      transition: { in: "slideRight", out: "fade" },
    });

    // ── Display text (fades in after 1 s, bottom third of frame) ─────
    textClips.push({
      asset: {
        type: "html",
        html: `<div style="font-family:Georgia,'Times New Roman',serif;color:#ffffff;font-size:27px;line-height:1.8;text-align:center;padding:28px 52px;text-shadow:2px 2px 8px rgba(0,0,0,1),-2px -2px 8px rgba(0,0,0,1),0 0 20px rgba(0,0,0,0.8);"><p style="margin:0;">${escHtml(seg.displayText)}</p></div>`,
        width: 1100,
        height: 300,
      },
      start: time + 1,
      length: dur - 1,
      position: "bottom",
      offset: { x: 0, y: 0.1 },
      transition: { in: "fade" },
    });

    time += dur;
  }

  const totalDuration = time;

  // ── Narration audio track ─────────────────────────────────────────
  const audioTrack = {
    clips: [
      {
        asset: { type: "audio", src: audioUrl, volume: 1.0 },
        start: 0,
        length: totalDuration,
      },
    ],
  };

  // ── Logo watermark (bottom right, full duration) ──────────────────
  const logoTrack = {
    clips: [
      {
        asset: { type: "image", src: logoUrl },
        start: 0,
        length: totalDuration,
        position: "bottomRight",
        offset: { x: -0.03, y: 0.03 },
        scale: 0.13,
        opacity: 0.9,
      },
    ],
  };

  // ── CTA end card (last 8 seconds) ─────────────────────────────────
  const ctaStart = Math.max(0, totalDuration - 8);
  const ctaTrack = {
    clips: [
      {
        asset: {
          type: "html",
          html: `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(27,42,74,0.92);padding:28px 48px;border-top:3px solid #C9A84C;border-bottom:3px solid #C9A84C;text-align:center;"><p style="font-family:Georgia,serif;color:#C9A84C;font-size:14px;text-transform:uppercase;letter-spacing:4px;margin:0 0 10px;">Speak with our advisers</p><p style="font-family:Georgia,serif;color:#ffffff;font-size:26px;margin:0;">aston.ae</p></div>`,
          width: 960,
          height: 140,
        },
        start: ctaStart,
        length: 8,
        position: "center",
        transition: { in: "fade", out: "fade" },
      },
    ],
  };

  // Background music — use env var override, a known-working public URL,
  // or omit entirely if neither is available.
  // SHOTSTACK_MUSIC_URL can be set to any publicly accessible MP3.
  const musicUrl =
    process.env.SHOTSTACK_MUSIC_URL ||
    "https://assets.mixkit.co/music/preview/mixkit-corporate-wisdom-225.mp3";

  const soundtrack = musicUrl
    ? { src: musicUrl, effect: "fadeOut", volume: 0.1 }
    : undefined;

  return {
    ...(soundtrack ? { soundtrack } : {}),
    background: "#000000",
    // Tracks render top-to-bottom: index 0 = topmost layer
    tracks: [
      logoTrack,                     // 0 — logo (always on top)
      ctaTrack,                      // 1 — end CTA
      { clips: titleClips },         // 2 — section title cards
      { clips: textClips },          // 3 — narration text
      { clips: overlayClips },       // 4 — dark overlay
      { clips: bgClips },            // 5 — background images (bottom)
      audioTrack,                    // 6 — narration audio
    ],
  };
}
