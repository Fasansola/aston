/**
 * src/remotion/VideoComposition.tsx
 *
 * Aston VIP branded video composition.
 * Rendered on AWS Lambda via @remotion/lambda.
 *
 * Layout per scene:
 *   0 → 2.5s  — Full-screen navy section title card (fades in/out)
 *   2.5s → mid — First half of display text subtitle bar
 *   mid → end  — Second half of display text subtitle bar (gold accent)
 *   Throughout — Background image with Ken Burns zoom + dark overlay
 *   Throughout — Logo watermark (bottom right)
 *   Last 12s   — Full-screen CTA overlay (aston.ae)
 */

import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VideoSegment {
  sectionTitle:    string;
  displayText:     string;
  durationSeconds: number;
  imageUrl:        string;
}

export interface VideoProps {
  segments: VideoSegment[];
  audioUrl: string;
  logoUrl:  string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FPS               = 24;   // 24fps reduces frame count by 20% vs 30fps
const TITLE_CARD_SECS   = 2.5;
const CTA_SECS          = 12;
const NAVY              = "#0f1a2e";
const GOLD              = "#C9A84C";

// ── Helpers ───────────────────────────────────────────────────────────────────

function splitText(text: string): [string, string] {
  const words = text.split(" ");
  const mid   = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

function fade(frame: number, inStart: number, inEnd: number, outStart: number, outEnd: number) {
  return interpolate(
    frame,
    [inStart, inEnd, outStart, outEnd],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

// ── TitleCard — full-screen navy card shown at the start of each scene ────────

const TitleCard: React.FC<{ title: string; index: number }> = ({ title, index }) => {
  const num = String(index + 1).padStart(2, "0");
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "rgba(15,26,46,0.96)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ width: 48, height: 3, backgroundColor: GOLD, marginBottom: 28 }} />
      <p
        style={{
          fontFamily: "Georgia, serif",
          color: GOLD,
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: "0.35em",
          margin: "0 0 18px",
        }}
      >
        {num}
      </p>
      <p
        style={{
          fontFamily: "Georgia, serif",
          color: "#ffffff",
          fontSize: 40,
          margin: 0,
          textAlign: "center",
          maxWidth: 680,
          lineHeight: 1.3,
          padding: "0 40px",
        }}
      >
        {title}
      </p>
      <div style={{ width: 48, height: 3, backgroundColor: GOLD, marginTop: 28 }} />
    </AbsoluteFill>
  );
};

// ── SubtitleBar — navy bar at bottom with display text ───────────────────────

const SubtitleBar: React.FC<{ text: string; gold?: boolean }> = ({ text, gold = false }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "stretch" }}>
    <div
      style={{
        backgroundColor: gold ? "rgba(27,42,74,0.97)" : "rgba(10,18,34,0.90)",
        borderTop: `3px solid ${gold ? GOLD : "rgba(201,168,76,0.45)"}`,
        padding: "18px 60px 20px",
        textAlign: "center",
      }}
    >
      <p
        style={{
          fontFamily: "Georgia, serif",
          color: "#ffffff",
          fontSize: 27,
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {text}
      </p>
    </div>
  </AbsoluteFill>
);

// ── Scene — one segment of the video ─────────────────────────────────────────

interface SceneProps {
  segment:   VideoSegment;
  index:     number;
  segFrames: number;
}

const Scene: React.FC<SceneProps> = ({ segment, index, segFrames }) => {
  const frame = useCurrentFrame();
  const titleFrames = Math.round(TITLE_CARD_SECS * FPS);

  // Simple fade-in at scene start (no per-frame scale calc = faster render)
  const fadeIn = frame < 8 ? frame / 8 : 1;

  // Title card opacity: fade in first 6 frames, hold, fade out last 6 frames
  const titleOpacity = fade(frame, 0, 6, titleFrames - 6, titleFrames);

  // Subtitle: first half then second half, simple step with short fades
  const subStart    = titleFrames;
  const subDur      = segFrames - titleFrames;
  const halfDur     = Math.floor(subDur / 2);
  const sub1Opacity = frame >= subStart && frame < subStart + halfDur ? 1 : 0;
  const sub2Opacity = frame >= subStart + halfDur ? 1 : 0;

  const [firstHalf, secondHalf] = splitText(segment.displayText);

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      {/* Background image — static (no Ken Burns per-frame calc) */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <Img
          src={segment.imageUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </AbsoluteFill>

      {/* Dark overlay — reliable opacity approach */}
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.52)" }} />

      {/* Full-screen section title card */}
      <AbsoluteFill style={{ opacity: titleOpacity }}>
        <TitleCard title={segment.sectionTitle} index={index} />
      </AbsoluteFill>

      {/* First-half subtitle */}
      <AbsoluteFill style={{ opacity: sub1Opacity }}>
        <SubtitleBar text={firstHalf} />
      </AbsoluteFill>

      {/* Second-half subtitle (gold accent) */}
      {secondHalf.trim() && (
        <AbsoluteFill style={{ opacity: sub2Opacity }}>
          <SubtitleBar text={secondHalf} gold />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

// ── CtaEndScreen — full-screen branded CTA for last 12 seconds ───────────────

const CtaEndScreen: React.FC<{ logoUrl: string }> = ({ logoUrl }) => {
  const frame     = useCurrentFrame();
  const ctaFrames = Math.round(CTA_SECS * FPS);
  const opacity   = fade(frame, 0, 18, ctaFrames - 18, ctaFrames);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: NAVY,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {logoUrl && (
        <Img
          src={logoUrl}
          style={{ height: 64, objectFit: "contain", marginBottom: 36 }}
        />
      )}
      <div style={{ width: 80, height: 3, backgroundColor: GOLD, marginBottom: 30 }} />
      <p
        style={{
          fontFamily: "Georgia, serif",
          color: GOLD,
          fontSize: 13,
          textTransform: "uppercase",
          letterSpacing: "0.4em",
          margin: "0 0 22px",
        }}
      >
        Corporate Advisory
      </p>
      <p
        style={{
          fontFamily: "Georgia, serif",
          color: "#ffffff",
          fontSize: 54,
          margin: "0 0 14px",
        }}
      >
        aston.ae
      </p>
      <p
        style={{
          fontFamily: "Georgia, serif",
          color: "rgba(255,255,255,0.58)",
          fontSize: 21,
          margin: 0,
        }}
      >
        Speak with our advisers today
      </p>
      <div style={{ width: 80, height: 3, backgroundColor: GOLD, marginTop: 30 }} />
    </AbsoluteFill>
  );
};

// ── LogoWatermark — persistent bottom-right logo ──────────────────────────────

const LogoWatermark: React.FC<{ logoUrl: string }> = ({ logoUrl }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-end" }}>
    <div style={{ padding: "0 18px 14px 0" }}>
      <Img
        src={logoUrl}
        style={{ height: 34, objectFit: "contain", opacity: 0.82 }}
      />
    </div>
  </AbsoluteFill>
);

// ── Main Composition ──────────────────────────────────────────────────────────

export const VideoComposition: React.FC<VideoProps> = ({ segments, audioUrl, logoUrl }) => {
  const { fps } = useVideoConfig();

  // Pre-compute each segment's frame count and start frame
  const segFrameCounts = segments.map((s) => Math.round(s.durationSeconds * fps));
  const segStarts      = segFrameCounts.map((_, i) =>
    segFrameCounts.slice(0, i).reduce((a, b) => a + b, 0)
  );
  const totalSceneFrames = segFrameCounts.reduce((a, b) => a + b, 0);
  const ctaFrames        = Math.round(CTA_SECS * fps);
  const ctaStart         = Math.max(0, totalSceneFrames - ctaFrames);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {/* Narration audio */}
      {audioUrl && <Audio src={audioUrl} />}

      {/* Scenes */}
      {segments.map((seg, i) => (
        <Sequence key={i} from={segStarts[i]} durationInFrames={segFrameCounts[i]}>
          <Scene segment={seg} index={i} segFrames={segFrameCounts[i]} />
        </Sequence>
      ))}

      {/* CTA overlay — last 12 seconds, over final scene */}
      <Sequence from={ctaStart} durationInFrames={ctaFrames}>
        <CtaEndScreen logoUrl={logoUrl} />
      </Sequence>

      {/* Logo watermark throughout */}
      {logoUrl && <LogoWatermark logoUrl={logoUrl} />}
    </AbsoluteFill>
  );
};
