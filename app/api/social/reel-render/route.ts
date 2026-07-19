/**
 * app/api/social/reel-render/route.ts
 *
 *   POST /api/social/reel-render        — start a render { script, title? }
 *   GET  /api/social/reel-render?id=…   — poll one job's status
 *   GET  /api/social/reel-render        — list recent jobs (the reel library)
 *
 * POST returns as soon as HeyGen accepts the job; the render then takes 3–8
 * minutes, so the client polls GET until the status is completed or failed.
 *
 * NOTE: each render consumes HeyGen credits, so this is only ever triggered by
 * an explicit user action — never automatically.
 */

import { NextRequest, NextResponse } from "next/server";
import { startReelRender, checkReelRender, getReelJobs } from "@/lib/social/reelVideo";

export const maxDuration = 300;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const script = typeof body.script === "string" ? body.script : "";
  if (!script.trim()) return NextResponse.json({ error: "script is required" }, { status: 400 });

  try {
    const job = await startReelRender({
      script,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    return NextResponse.json({ job });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[social/reel-render] start failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ jobs: await getReelJobs() });

  const job = await checkReelRender(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}
