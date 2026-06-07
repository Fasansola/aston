/**
 * lib/remotionRenderer.ts
 *
 * Thin wrapper around @remotion/lambda-client for use in Next.js API routes.
 */

import {
  renderMediaOnLambda,
  getRenderProgress,
  type AwsRegion,
} from "@remotion/lambda-client";
import type { VideoSegment } from "@/src/remotion/VideoComposition";

const REGION        = (process.env.REMOTION_AWS_REGION   ?? "us-east-1") as AwsRegion;
const FUNCTION_NAME =  process.env.REMOTION_FUNCTION_NAME ?? "";
const SERVE_URL     =  process.env.REMOTION_SERVE_URL     ?? "";

if (!FUNCTION_NAME) console.warn("[remotion] REMOTION_FUNCTION_NAME is not set");
if (!SERVE_URL)     console.warn("[remotion] REMOTION_SERVE_URL is not set");

export interface RenderInput {
  segments:  VideoSegment[];
  audioUrl:  string;
  logoUrl:   string;
  musicUrl?: string;
  outName:   string;
}

export async function submitRemotionRender(
  input: RenderInput
): Promise<{ renderId: string; bucketName: string }> {
  const { renderId, bucketName } = await renderMediaOnLambda({
    region:       REGION,
    functionName: FUNCTION_NAME,
    serveUrl:     SERVE_URL,
    composition:  "AstonVideo",
    inputProps: {
      segments: input.segments,
      audioUrl: input.audioUrl,
      logoUrl:  input.logoUrl,
      musicUrl: input.musicUrl ?? "",
    },
    codec:       "h264",
    imageFormat: "jpeg",
    maxRetries:  5,
    privacy:     "public",
    outName:     input.outName,
    downloadBehavior: { type: "play-in-browser" },
    framesPerLambda: 150,
  });

  return { renderId, bucketName };
}

export async function pollRemotionRender(
  renderId:   string,
  bucketName: string
): Promise<{ status: string; progress: number; url?: string; error?: string }> {
  const result = await getRenderProgress({
    renderId,
    bucketName,
    functionName: FUNCTION_NAME,
    region:       REGION,
  });

  if (result.fatalErrorEncountered) {
    const msg = result.errors?.[0]?.message ?? "Render failed";
    return { status: "error", progress: 0, error: msg };
  }

  if (result.done) {
    return { status: "done", progress: 1, url: result.outputFile ?? undefined };
  }

  return { status: "rendering", progress: result.overallProgress ?? 0 };
}
