/**
 * app/api/generate-workflow/[runId]/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/generate-workflow/[runId]?startIndex=N
 *
 * Re-attaches to a still-running (or completed) generation workflow and streams
 * its events from `startIndex` onward. This is what makes the pipeline resilient
 * to dropped connections: if the live stream from POST is interrupted, the work
 * keeps running durably and the client reconnects here to continue receiving
 * progress + the final result — no regeneration, no lost article.
 */

import { NextRequest } from "next/server";
import { getRun } from "workflow/api";

export const maxDuration = 300;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const startIndexParam = req.nextUrl.searchParams.get("startIndex");
  const startIndex = startIndexParam ? parseInt(startIndexParam, 10) : undefined;

  const run = getRun(runId);
  const stream = run.getReadable({ startIndex });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
