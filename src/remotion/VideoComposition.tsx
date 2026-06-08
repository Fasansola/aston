import React from "react";
import {
  AbsoluteFill, Audio, Img, Sequence,
  interpolate, useCurrentFrame, useVideoConfig, Loop,
} from "remotion";

export interface VideoSegment {
  sectionTitle:    string;
  displayText:     string;
  bullets:         string[];
  durationSeconds: number;
  imageUrl:        string;
}

export interface VideoProps {
  segments:  VideoSegment[];
  audioUrl:  string;
  logoUrl:   string;
  musicUrl?: string;
}

const FPS             = 30;
const INTRO_SECS      = 3;
const TITLE_CARD_SECS = 2.5;
const CTA_SECS        = 12;
const NAVY            = "#0f1a2e";
const GOLD            = "#C9A84C";

export const INTRO_FRAMES = INTRO_SECS * FPS;


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

const ContentPanel: React.FC<{
  sectionTitle: string;
  bullets:      string[];
  frame:        number;
  subStart:     number;
  segFrames:    number;
}> = ({ sectionTitle, bullets, frame, subStart, segFrames }) => {
  const panelOp = fade(frame, subStart, subStart + 12, segFrames - 8, segFrames);
  return (
    <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", paddingLeft: 64 }}>
      <div style={{ backgroundColor: "rgba(15,26,46,0.93)", borderLeft: `4px solid ${GOLD}`, padding: "32px 44px", maxWidth: "50%", opacity: panelOp }}>
        <p style={{ fontFamily: "Georgia, serif", color: GOLD, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.38em", margin: "0 0 12px" }}>
          {sectionTitle}
        </p>
        <div style={{ width: 36, height: 2, backgroundColor: GOLD, marginBottom: 24 }} />
        {bullets.map((bullet, i) => {
          const bulletOp = interpolate(frame, [subStart + 18 + i * 28, subStart + 28 + i * 28], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", marginBottom: i < bullets.length - 1 ? 20 : 0, opacity: bulletOp }}>
              <span style={{ color: GOLD, fontSize: 17, marginRight: 14, marginTop: 4, flexShrink: 0, lineHeight: 1 }}>✓</span>
              <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 22, lineHeight: 1.45, margin: 0 }}>{bullet}</p>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Scene: React.FC<{ segment: VideoSegment; index: number; segFrames: number }> = ({ segment, index, segFrames }) => {
  const frame       = useCurrentFrame();
  const titleFrames = Math.round(TITLE_CARD_SECS * FPS);
  const scale       = interpolate(frame, [0, segFrames], [1.0, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeIn      = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const titleOp     = fade(frame, 0, 8, titleFrames - 8, titleFrames);
  const subStart = titleFrames;

  return (
    <AbsoluteFill style={{ opacity: fadeIn }}>
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <Img src={segment.imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})`, transformOrigin: index % 2 === 0 ? "left center" : "right center" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.60)" }} />
      <AbsoluteFill style={{ opacity: titleOp }}><TitleCard title={segment.sectionTitle} index={index} /></AbsoluteFill>
      <ContentPanel sectionTitle={segment.sectionTitle} bullets={segment.bullets ?? []} frame={frame} subStart={subStart} segFrames={segFrames} />
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

const IntroCard: React.FC<{ logoUrl: string }> = ({ logoUrl }) => {
  const frame   = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20, INTRO_FRAMES - 15, INTRO_FRAMES], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: NAVY, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity }}>
      {logoUrl && <Img src={logoUrl} style={{ height: 72, objectFit: "contain", marginBottom: 24 }} />}
      <div style={{ width: 60, height: 2, backgroundColor: GOLD }} />
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

export const VideoComposition: React.FC<VideoProps> = ({ segments, audioUrl, logoUrl, musicUrl }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const segFrameCounts = segments.map(s => Math.round(s.durationSeconds * fps));
  const segStarts      = segFrameCounts.map((_, i) => INTRO_FRAMES + segFrameCounts.slice(0, i).reduce((a, b) => a + b, 0));
  const contentFrames  = segFrameCounts.reduce((a, b) => a + b, 0);
  const ctaFrames      = Math.round(CTA_SECS * fps);
  const ctaStart       = Math.max(INTRO_FRAMES, INTRO_FRAMES + contentFrames - ctaFrames);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {audioUrl && <Sequence from={INTRO_FRAMES}><Audio src={audioUrl} /></Sequence>}
      {musicUrl && (
        <Loop durationInFrames={durationInFrames}>
          <Audio
            src={musicUrl}
            volume={(f) =>
              interpolate(
                f,
                [0, 45, durationInFrames - 45, durationInFrames],
                [0, 0.12, 0.12, 0],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              )
            }
          />
        </Loop>
      )}
      <Sequence from={0} durationInFrames={INTRO_FRAMES}>
        <IntroCard logoUrl={logoUrl} />
      </Sequence>
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
