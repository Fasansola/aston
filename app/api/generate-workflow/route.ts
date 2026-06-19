/**
 * app/api/generate-workflow/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-workflow  — durable, resumable replacement for
 * /api/generate, powered by the Workflow DevKit.
 *
 * Runs alongside the old monolithic route during validation. The old route
 * stays live until this one is proven on a preview deploy.
 *
 * Validation errors (400/401) return plain JSON before the workflow starts.
 * On success it starts the workflow and streams the run's readable back to the
 * client in the SAME SSE shape the old route used, so the client's existing
 * event handling keeps working. Because the work runs in durable steps, even if
 * this streaming connection drops the run keeps going and can be re-attached via
 * GET /api/generate-workflow/[runId].
 */

import { NextRequest, NextResponse } from "next/server";
import { start } from "workflow/api";
import { getSettings } from "@/lib/storage";
import { type ImageModel } from "@/lib/openai";
import { GenerationMode } from "@/lib/source";
import { generatePostWorkflow, type GeneratePostInput } from "@/lib/workflows/generatePost";

// The route only starts the workflow and proxies its stream; the heavy work runs
// in separate durable step invocations, each with its own budget.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const {
    topic = "", mode = "topic_only", sourceText = "", audience = "",
    primary_country = "", secondary_countries = "", priority_service = "",
    language = "", customPrompt = "", imageModel: bodyImageModel = "",
  } = body as {
    topic?: string; mode?: GenerationMode; sourceText?: string; audience?: string;
    primary_country?: string; secondary_countries?: string; priority_service?: string;
    language?: string; customPrompt?: string; imageModel?: string;
  };

  const hasTopic        = typeof topic === "string" && topic.trim().length >= 5;
  const hasCustomPrompt = typeof customPrompt === "string" && customPrompt.trim().length >= 10;

  if (!hasTopic && !hasCustomPrompt) {
    return NextResponse.json(
      { error: "Please provide a blog topic or a custom prompt (at least 10 characters)." },
      { status: 400 }
    );
  }

  const validModes: GenerationMode[] = ["topic_only", "source_assisted", "improve_existing", "notes_to_article"];
  if (!validModes.includes(mode as GenerationMode)) {
    return NextResponse.json({ error: "Invalid generation mode." }, { status: 400 });
  }
  if (mode !== "topic_only" && !sourceText?.trim()) {
    return NextResponse.json({ error: "Source text is required for this generation mode." }, { status: 400 });
  }

  const settings = await getSettings();
  const imageModel: ImageModel =
    bodyImageModel === "imagen-4"    ? "imagen-4"    :
    bodyImageModel === "gpt-image-2" ? "gpt-image-2" :
    settings.imageModel ?? "gpt-image-2";

  const input: GeneratePostInput = {
    hasTopic,
    title: hasTopic ? topic.trim() : "",
    mode: mode as GenerationMode,
    sourceText: sourceText ?? "",
    audience: audience ?? "",
    primary_country: primary_country ?? "",
    secondary_countries: secondary_countries ?? "",
    priority_service: priority_service ?? "",
    language: language ?? "",
    customInstruction: (customPrompt as string).trim() || undefined,
    imageModel,
  };

  let run: Awaited<ReturnType<typeof start>>;
  try {
    run = await start(generatePostWorkflow, [input]);
  } catch (err) {
    const msg = err instanceof Error && err.message
      ? err.message
      : `Workflow failed to start: ${String(err)}`;
    console.error("[generate-workflow] start() threw:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Stream the workflow's SSE events back. The runId header lets the client
  // reconnect to this run if the connection drops mid-generation.
  return new Response(run.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Workflow-Run-Id": run.runId,
    },
  });
}
