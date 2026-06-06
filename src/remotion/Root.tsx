import React from "react";
import { Composition } from "remotion";
import { VideoComposition, type VideoProps } from "./VideoComposition";

const DEFAULT_PROPS: VideoProps = {
  segments: [
    {
      sectionTitle: "Introduction",
      displayText: "Welcome to this overview from Aston VIP Corporate Advisory.",
      durationSeconds: 10,
      imageUrl: "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=1280",
    },
  ],
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
    calculateMetadata={({ props }) => {
      const p = props as unknown as VideoProps;
      const totalFrames = p.segments.reduce(
        (acc: number, seg: { durationSeconds: number }) => acc + Math.round(seg.durationSeconds * 30),
        0
      );
      return { durationInFrames: Math.max(totalFrames, 30) };
    }}
  />
);
