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
  const titleClips: object[] = [];
  const textClips:  object[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = seg.durationSeconds;

    // ── Background image ───────────────────────────────────────────────
    // opacity: 0.55 against a black timeline background = 45% black shows
    // through = naturally darkened cinematic look. Far more reliable than
    // a separate HTML overlay layer which Shotstack renders inconsistently.
    bgClips.push({
      asset: { type: "image", src: seg.imageUrl },
      start: time,
      length: dur,
      effect: i % 2 === 0 ? "zoomIn" : "zoomOut",
      opacity: 0.55,
      transition: { in: "fade", out: "fade" },
    });

    // ── Section title card — top-left, slides in for first 3 s ────────
    // offset is relative to the clip anchor, not screen centre.
    // position "topLeft" + offset {x:0, y:0} = exactly top-left corner.
    // Small positive values nudge it inward from the edge.
    titleClips.push({
      asset: {
        type: "html",
        html: `<div style="display:inline-flex;align-items:center;padding:14px 28px;background:rgba(27,42,74,0.95);border-left:5px solid #C9A84C;"><span style="font-family:Georgia,serif;color:#C9A84C;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:3px;text-decoration:none;">${escHtml(seg.sectionTitle)}</span></div>`,
        width: 660,
        height: 60,
      },
      start: time,
      length: 3,
      position: "topLeft",
      offset: { x: 0.02, y: 0.04 },
      transition: { in: "slideRight", out: "fade" },
    });

    // ── Display text — centred in lower third ──────────────────────────
    // Uses a semi-transparent navy bar so text is always legible regardless
    // of how bright or busy the background image is.
    // text-decoration:none prevents Chromium default link underlines.
    textClips.push({
      asset: {
        type: "html",
        html: `<div style="width:100%;background:rgba(15,26,46,0.78);padding:22px 40px;text-align:center;box-sizing:border-box;border-top:2px solid rgba(201,168,76,0.6);"><p style="font-family:Georgia,'Times New Roman',serif;color:#ffffff;font-size:28px;line-height:1.7;margin:0;text-decoration:none;font-style:normal;">${escHtml(seg.displayText)}</p></div>`,
        width: 1280,
        height: 140,
      },
      start: time + 1,
      length: dur - 1,
      position: "bottom",
      offset: { x: 0, y: 0 },
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
    // Tracks render top-to-bottom: index 0 = topmost layer.
    // No separate overlay track — images are darkened via opacity: 0.55
    // against the black timeline background, which is more reliable.
    tracks: [
      logoTrack,                // 0 — logo (always on top)
      ctaTrack,                 // 1 — end CTA
      { clips: titleClips },    // 2 — section title cards (navy/gold)
      { clips: textClips },     // 3 — display text (navy bar + white text)
      { clips: bgClips },       // 4 — background images (darkened via opacity)
      audioTrack,               // 5 — narration audio
    ],
  };
}
