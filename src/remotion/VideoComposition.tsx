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
const TRANS_FRAMES    = 22; // scene cross-fade duration (~0.73 s)
const NAVY            = "#0f1a2e";
const GOLD            = "#C9A84C";

export const INTRO_FRAMES   = INTRO_SECS * FPS;
export const OUTRO_FRAMES   = 5 * FPS;
const MUSIC_LOOP_FRAMES     = 120 * FPS; // loop every ~2 min


function fade(frame: number, i0: number, i1: number, o0: number, o1: number) {
  return interpolate(frame, [i0, i1, o0, o1], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
}

const MusicTrack: React.FC<{ src: string; totalFrames: number }> = ({ src, totalFrames }) => {
  const frame  = useCurrentFrame();
  const volume = interpolate(
    frame,
    [0, 45, Math.max(46, totalFrames - OUTRO_FRAMES), totalFrames],
    [0, 0.07, 0.07, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <Loop durationInFrames={MUSIC_LOOP_FRAMES}>
      <Audio src={src} volume={volume} />
    </Loop>
  );
};

const TitleCard: React.FC<{ title: string; index: number }> = ({ title, index }) => (
  <AbsoluteFill style={{ backgroundColor: NAVY, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
    <div style={{ width: 48, height: 3, backgroundColor: GOLD, marginBottom: 28 }} />
    <p style={{ fontFamily: "Georgia, serif", color: GOLD, fontSize: 22, textTransform: "uppercase", letterSpacing: "0.35em", margin: "0 0 18px" }}>
      {String(index + 1).padStart(2, "0")}
    </p>
    <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 56, margin: 0, textAlign: "center", maxWidth: 900, lineHeight: 1.22, padding: "0 40px" }}>
      {title}
    </p>
    <div style={{ width: 48, height: 3, backgroundColor: GOLD, marginTop: 28 }} />
  </AbsoluteFill>
);

const Scene: React.FC<{ segment: VideoSegment; index: number; segFrames: number }> = ({ segment, index, segFrames }) => {
  const frame       = useCurrentFrame();
  const titleFrames = Math.round(TITLE_CARD_SECS * FPS);
  const scale       = interpolate(frame, [0, segFrames], [1.0, 1.06], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Outer: snaps in immediately, then fades smoothly to navy background at scene end
  const sceneOp  = interpolate(frame, [0, 6, segFrames - TRANS_FRAMES, segFrames], [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Title card: slower fade-in/out so it's always fully opaque before content is revealed
  const titleOp  = fade(frame, 0, 15, titleFrames - 18, titleFrames);

  // Content (both panels): fades IN after title card disappears — no explicit fade-out
  // (the outer sceneOp handles the end-of-scene fade to navy)
  const contentOp = interpolate(frame, [titleFrames, titleFrames + 18], [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const subStart = titleFrames;

  return (
    <AbsoluteFill style={{ opacity: sceneOp }}>

      {/* LEFT: solid navy editorial panel */}
      <div style={{
        position: "absolute", left: 0, top: 0,
        width: "44%", height: "100%",
        backgroundColor: NAVY,
        borderRight: `3px solid ${GOLD}`,
        overflow: "hidden",
        boxSizing: "border-box",
      }}>
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column", justifyContent: "center",
          padding: "0 52px",
          opacity: contentOp,
          boxSizing: "border-box",
        }}>
          <p style={{ fontFamily: "Georgia, serif", color: GOLD, fontSize: 20, textTransform: "uppercase", letterSpacing: "0.42em", margin: "0 0 12px" }}>
            {String(index + 1).padStart(2, "0")}
          </p>
          <div style={{ width: 44, height: 3, backgroundColor: GOLD, marginBottom: 18 }} />
          <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 48, lineHeight: 1.2, margin: "0 0 16px" }}>
            {segment.sectionTitle}
          </p>
          <p style={{ fontFamily: "Georgia, serif", color: "rgba(255,255,255,0.78)", fontSize: 28, lineHeight: 1.5, margin: "0 0 22px" }}>
            {segment.displayText}
          </p>
          <div style={{ width: 36, height: 1, backgroundColor: "rgba(201,168,76,0.45)", marginBottom: 20 }} />
          {(segment.bullets ?? []).map((bullet, i) => {
            const bulletOp = interpolate(frame, [subStart + 18 + i * 28, subStart + 28 + i * 28], [0, 1], {
              extrapolateLeft: "clamp", extrapolateRight: "clamp",
            });
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", marginBottom: i < (segment.bullets ?? []).length - 1 ? 15 : 0, opacity: bulletOp }}>
                <span style={{ color: GOLD, fontSize: 18, marginRight: 12, marginTop: 3, flexShrink: 0, lineHeight: 1 }}>✓</span>
                <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 28, lineHeight: 1.36, margin: 0 }}>{bullet}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* RIGHT: image with lighter overlay — contentOp keeps it hidden while title card is up */}
      <div style={{
        position: "absolute", right: 0, top: 0,
        width: "56%", height: "100%",
        overflow: "hidden",
        opacity: contentOp,
      }}>
        <Img
          src={segment.imageUrl}
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})`, transformOrigin: index % 2 === 0 ? "left center" : "right center" }}
        />
        <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.28)" }} />
      </div>

      {/* Full-screen title card overlay for first 2.5 s */}
      <AbsoluteFill style={{ opacity: titleOp }}>
        <TitleCard title={segment.sectionTitle} index={index} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const CtaEndScreen: React.FC<{ logoUrl: string }> = ({ logoUrl }) => {
  const frame   = useCurrentFrame();
  // Fade in over 18 frames; hold for the full 5 s; fade out gently in the final 10 frames
  const opacity = interpolate(frame, [0, 18, OUTRO_FRAMES - 10, OUTRO_FRAMES], [0, 1, 1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: NAVY, opacity, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      {logoUrl && <Img src={logoUrl} style={{ height: 64, objectFit: "contain", marginBottom: 36 }} />}
      <div style={{ width: 80, height: 3, backgroundColor: GOLD, marginBottom: 30 }} />
      <p style={{ fontFamily: "Georgia, serif", color: GOLD, fontSize: 20, textTransform: "uppercase", letterSpacing: "0.4em", margin: "0 0 22px" }}>Corporate Advisory</p>
      <p style={{ fontFamily: "Georgia, serif", color: "#ffffff", fontSize: 54, margin: "0 0 14px" }}>aston.ae</p>
      <p style={{ fontFamily: "Georgia, serif", color: "rgba(255,255,255,0.58)", fontSize: 30, margin: 0 }}>Speak with our advisers today</p>
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
      {logoUrl && <Img src={logoUrl} style={{ height: 130, objectFit: "contain", marginBottom: 30 }} />}
      <div style={{ width: 60, height: 2, backgroundColor: GOLD }} />
    </AbsoluteFill>
  );
};

const LogoWatermark: React.FC<{ logoUrl: string }> = ({ logoUrl }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-end" }}>
    <div style={{ padding: "0 22px 18px 0" }}>
      <Img src={logoUrl} style={{ height: 52, objectFit: "contain", opacity: 0.9 }} />
    </div>
  </AbsoluteFill>
);

export const VideoComposition: React.FC<VideoProps> = ({ segments, audioUrl, logoUrl, musicUrl }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const segFrameCounts = segments.map(s => Math.round(s.durationSeconds * fps));
  const segStarts      = segFrameCounts.map((_, i) => INTRO_FRAMES + segFrameCounts.slice(0, i).reduce((a, b) => a + b, 0));
  const contentFrames  = segFrameCounts.reduce((a, b) => a + b, 0);
  // CTA starts the instant the last content scene ends and lasts exactly OUTRO_FRAMES (5 s)
  const ctaStart       = INTRO_FRAMES + contentFrames;

  return (
    // NAVY background — scenes fade to/from navy, giving smooth cross-fades without black flashes
    <AbsoluteFill style={{ backgroundColor: NAVY }}>
      {audioUrl && <Sequence from={INTRO_FRAMES}><Audio src={audioUrl} /></Sequence>}
      {musicUrl && <MusicTrack src={musicUrl} totalFrames={durationInFrames} />}
      <Sequence from={0} durationInFrames={INTRO_FRAMES}>
        <IntroCard logoUrl={logoUrl} />
      </Sequence>
      {segments.map((seg, i) => (
        <Sequence key={i} from={segStarts[i]} durationInFrames={segFrameCounts[i]}>
          <Scene segment={seg} index={i} segFrames={segFrameCounts[i]} />
        </Sequence>
      ))}
      <Sequence from={ctaStart} durationInFrames={OUTRO_FRAMES}>
        <CtaEndScreen logoUrl={logoUrl} />
      </Sequence>
      {logoUrl && <LogoWatermark logoUrl={logoUrl} />}
    </AbsoluteFill>
  );
};
