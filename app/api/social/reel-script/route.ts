/**
 * app/api/social/reel-script/route.ts
 * POST /api/social/reel-script
 *
 * Generates short vertical-reel scripts in the Aston VIP presenter's voice —
 * step one of the social studio's video pipeline, before any HeyGen credits are
 * spent. Pass `count` to generate several variations of the same topic so you
 * can pick the strongest hook.
 *
 * Body: { topic, angle?, durationSeconds?, language?, count? }
 */

import { NextRequest, NextResponse } from "next/server";
import { generateReelScript, type ReelScript } from "@/lib/social/reelScript";

export const maxDuration = 300;

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) return NextResponse.json({ error: "topic is required" }, { status: 400 });

  const count = Math.min(5, Math.max(1, Number(body.count) || 1));
  const request = {
    topic,
    angle: typeof body.angle === "string" ? body.angle : undefined,
    durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : undefined,
    language: typeof body.language === "string" ? body.language : undefined,
  };

  try {
    // Variations are independent — generate them concurrently.
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () => generateReelScript(request))
    );

    const scripts: ReelScript[] = [];
    const errors: string[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") scripts.push(r.value);
      else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }

    if (scripts.length === 0) {
      return NextResponse.json({ error: errors[0] ?? "Script generation failed" }, { status: 502 });
    }

    console.log(
      `[social/reel-script] "${topic}" → ${scripts.length}/${count} script(s), ` +
        `${scripts.map((s) => `${s.wordCount}w/${s.estimatedSeconds}s`).join(", ")}` +
        (errors.length ? `; ${errors.length} failed` : "")
    );
    return NextResponse.json({ scripts, ...(errors.length ? { errors } : {}) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[social/reel-script] failed for "${topic}": ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
