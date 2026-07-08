/**
 * app/api/post-media/[runId]/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET /api/post-media/[runId]?startIndex=N
 *
 * Follows a durable generateMediaWorkflow run and streams its progress events
 * (audio / video render / podcast) to the Media page, exactly like the main
 * route follows generatePostWorkflow. Survives dropped connections: the run
 * keeps executing server-side and the client reconnects here.
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

  // 15s keepalive comments so proxies don't kill the connection during the
  // long (multi-minute) video render, which emits no events while polling.
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
