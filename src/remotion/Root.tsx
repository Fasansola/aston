/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import { Composition } from "remotion";
import { VideoComposition, type VideoProps, type VideoSegment, INTRO_FRAMES, OUTRO_FRAMES } from "./VideoComposition";

const DEFAULT_PROPS: VideoProps = {
  segments: [{ sectionTitle: "Introduction", displayText: "Welcome to Aston VIP Corporate Advisory.", bullets: ["Expert corporate advisory services", "Operating across UAE and international jurisdictions", "Speak with our advisers today"], durationSeconds: 10, imageUrl: "https://placehold.co/1280x720/0f1a2e/0f1a2e.png", narration: "Welcome to Aston VIP Corporate Advisory. We help entrepreneurs and investors set up compliant international structures. Our advisers work across the UAE, UK and beyond." }],
  audioUrl: "",
  logoUrl:  "",
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="AstonVideo"
    component={VideoComposition as any}
    fps={30}
    width={1280}
    height={720}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={({ props }: { props: unknown }) => {
      const p = props as VideoProps;
      return {
        durationInFrames: Math.max(
          p.segments.reduce((acc: number, s: VideoSegment) => acc + Math.round(s.durationSeconds * 30), 0) + INTRO_FRAMES + OUTRO_FRAMES,
          30
        ),
      };
    }}
  />
);
