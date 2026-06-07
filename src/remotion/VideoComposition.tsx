import React from "react";
import {
  AbsoluteFill, Audio, Img, Sequence,
  interpolate, useCurrentFrame, useVideoConfig,
} from "remotion";

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

const FPS             = 30;
const TITLE_CARD_SECS = 2.5;
const CTA_SECS        = 12;
const NAVY            = "#0f1a2e";
const GOLD            = "#C9A84C";

function splitText(text: string): [string, string] {
  const words = text.split(" ");
  const mid   = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

function fade(frame: number, i0: number, i1: number, o0: number, o1: number) {
  return interpolate(frame, [i0, i1, o0, o1], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
}

const TitleCard: React.FC<{ title: string; index: number }> = ({ title, index }) => (
  <AbsoluteFill style={{ backgroundColor: "rgba(15,26,46,0.96)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
    <div style={{ width: 48, height: 3, backgroundColor: GOLD, marginBottom: 28 }} />
    <p style={{ fontFamily: "Georgia, serif", color: GOLD, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.35em", margin: "0 0 18px" }}>
      {String(index + 1).padStart(2, "0")}
    </p>
    <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 40, margin: 0, textAlign: "center", maxWidth: 680, lineHeight: 1.3, padding: "0 40px" }}>
      {title}
    </p>
    <div style={{ width: 48, height: 3, backgroundColor: GOLD, marginTop: 28 }} />
  </AbsoluteFill>
);

const SubtitleBar: React.FC<{ text: string; gold?: boolean }> = ({ text, gold = false }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "stretch" }}>
    <div style={{ backgroundColor: gold ? "rgba(27,42,74,0.97)" : "rgba(10,18,34,0.90)", borderTop: `3px solid ${gold ? GOLD : "rgba(201,168,76,0.45)"}`, padding: "18px 60px 20px", textAlign: "center" }}>
      <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 27, lineHeight: 1.5, margin: 0 }}>{text}</p>
    </div>
  </AbsoluteFill>
);

const Scene: React.FC<{ segment: VideoSegment; index: number; segFrames: number }> = ({ segment, index, segFrames }) => {
  const frame       = useCurrentFrame();
  const titleFrames = Math.round(TITLE_CARD_SECS * FPS);
  const scale       = interpolate(frame, [0, segFrames], [1.0, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeIn      = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const titleOp     = fade(frame, 0, 8, titleFrames - 8, titleFrames);
  const subStart    = titleFrames;
  const halfDur     = Math.floor((segFrames - titleFrames) / 2);
  const sub1Op      = fade(frame, subStart, subStart + 8, subStart + halfDur - 6, subStart + halfDur);
  const sub2Op      = fade(frame, subStart + halfDur, subStart + halfDur + 8, segFrames - 6, segFrames);
  const [first, second] = splitText(segment.displayText);

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <Img src={segment.imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})`, transformOrigin: index % 2 === 0 ? "left center" : "right center" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.52)" }} />
      <AbsoluteFill style={{ opacity: titleOp }}><TitleCard title={segment.sectionTitle} index={index} /></AbsoluteFill>
      <AbsoluteFill style={{ opacity: sub1Op }}><SubtitleBar text={first} /></AbsoluteFill>
      {second.trim() && <AbsoluteFill style={{ opacity: sub2Op }}><SubtitleBar text={second} gold /></AbsoluteFill>}
    </AbsoluteFill>
  );
};

const CtaEndScreen: React.FC<{ logoUrl: string }> = ({ logoUrl }) => {
  const frame     = useCurrentFrame();
  const ctaFrames = Math.round(CTA_SECS * FPS);
  const opacity   = fade(frame, 0, 18, ctaFrames - 18, ctaFrames);
  return (
    <AbsoluteFill style={{ backgroundColor: NAVY, opacity, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      {logoUrl && <Img src={logoUrl} style={{ height: 64, objectFit: "contain", marginBottom: 36 }} />}
      <div style={{ width: 80, height: 3, backgroundColor: GOLD, marginBottom: 30 }} />
      <p style={{ fontFamily: "Georgia, serif", color: GOLD, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.4em", margin: "0 0 22px" }}>Corporate Advisory</p>
      <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 54, margin: "0 0 14px" }}>aston.ae</p>
      <p style={{ fontFamily: "Georgia, serif", color: "rgba(255,255,255,0.58)", fontSize: 21, margin: 0 }}>Speak with our advisers today</p>
      <div style={{ width: 80, height: 3, backgroundColor: GOLD, marginTop: 30 }} />
    </AbsoluteFill>
  );
};

const LogoWatermark: React.FC<{ logoUrl: string }> = ({ logoUrl }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-end" }}>
    <div style={{ padding: "0 18px 14px 0" }}>
      <Img src={logoUrl} style={{ height: 34, objectFit: "contain", opacity: 0.82 }} />
    </div>
  </AbsoluteFill>
);

export const VideoComposition: React.FC<VideoProps> = ({ segments, audioUrl, logoUrl }) => {
  const { fps } = useVideoConfig();
  const segFrameCounts = segments.map(s => Math.round(s.durationSeconds * fps));
  const segStarts      = segFrameCounts.map((_, i) => segFrameCounts.slice(0, i).reduce((a, b) => a + b, 0));
  const totalFrames    = segFrameCounts.reduce((a, b) => a + b, 0);
  const ctaFrames      = Math.round(CTA_SECS * fps);
  const ctaStart       = Math.max(0, totalFrames - ctaFrames);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {audioUrl && <Audio src={audioUrl} />}
      {segments.map((seg, i) => (
        <Sequence key={i} from={segStarts[i]} durationInFrames={segFrameCounts[i]}>
          <Scene segment={seg} index={i} segFrames={segFrameCounts[i]} />
        </Sequence>
      ))}
      <Sequence from={ctaStart} durationInFrames={ctaFrames}>
        <CtaEndScreen logoUrl={logoUrl} />
      </Sequence>
      {logoUrl && <LogoWatermark logoUrl={logoUrl} />}
    </AbsoluteFill>
  );
};
