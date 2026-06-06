/**
 * lib/remotionRenderer.ts
 *
 * Thin wrapper around @remotion/lambda/client for use in Next.js API routes.
 * Import from here — not directly from @remotion/lambda — so we always use
 * the /client sub-path which excludes browser-only code.
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
  outName:   string;
}

/**
 * Submits a video render job to AWS Lambda via Remotion.
 * Returns { renderId, bucketName } — both needed for polling.
 */
export async function submitRemotionRender(
  input: RenderInput
): Promise<{ renderId: string; bucketName: string }> {
  const { renderId, bucketName } = await renderMediaOnLambda({
    region:      REGION,
    functionName: FUNCTION_NAME,
    serveUrl:    SERVE_URL,
    composition: "AstonVideo",
    inputProps:  {
      segments: input.segments,
      audioUrl: input.audioUrl,
      logoUrl:  input.logoUrl,
    },
    codec:       "h264",
    imageFormat: "jpeg",
    maxRetries:  1,
    privacy:     "public",
    outName:     input.outName,
    downloadBehavior: { type: "play-in-browser" },
  });

  return { renderId, bucketName };
}

/**
 * Polls a render job for its current status.
 * Returns:
 *   status  — "rendering" | "done" | "error"
 *   progress — 0–1
 *   url      — public MP4 URL (only when status === "done")
 *   error    — error message (only when status === "error")
 */
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
    return {
      status:   "done",
      progress: 1,
      url:      result.outputFile ?? undefined,
    };
  }

  return {
    status:   "rendering",
    progress: result.overallProgress ?? 0,
  };
}
