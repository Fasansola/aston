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
  const source = run.getReadable({ startIndex });

  // Wrap the run stream with periodic SSE comments (": ping") so the
  // connection is never silent for minutes at a time — long steps (content
  // writing, QA fix passes) emit no events for up to ~5 minutes, and idle
  // connections get killed by proxies, which made the client burn through its
  // reconnect budget and report a failure while the run was still healthy.
  // SSE comments are ignored by the client's "data:" parser.
  const encoder = new TextEncoder();
  const reader = source.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { clearInterval(ping); }
      }, 15_000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
        }
      } catch (err) {
        clearInterval(ping);
        controller.error(err);
        return;
      }
      clearInterval(ping);
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
