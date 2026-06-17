/**
 * app/api/generate-podcast-test/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-podcast-test  { title, sourceText?, ttsProvider?, length? }
 *
 * Standalone podcast test — generates the dialogue + audio from a topic/title
 * (no blog post needed) and returns the MP3 inline as base64, plus the
 * transcript. Nothing is uploaded to WordPress and no episode is created; this
 * is purely for previewing script quality and voices (mirrors /api/generate-video
 * being usable from the /video page).
 */

import { NextRequest } from "next/server";
import { generatePodcastDialogue, type PodcastLengthMins } from "@/lib/podcastDialogue";
import { buildPodcastEpisode } from "@/lib/podcastAudio";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let body: { title?: string; sourceText?: string; length?: number };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 }); }

  const title = body.title?.trim();
  if (!title) {
    return new Response(JSON.stringify({ error: "A topic or title is required." }), { status: 400 });
  }

  const validLengths: PodcastLengthMins[] = [15, 30, 45, 60];
  const length: PodcastLengthMins = validLengths.includes(body.length as PodcastLengthMins) ? (body.length as PodcastLengthMins) : 15;
  if (!process.env.ELEVENLABS_API_KEY) {
    return new Response(JSON.stringify({ error: "Voice engine not configured. Missing: ELEVENLABS_API_KEY" }), { status: 503 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: Record<string, unknown>) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        send({ type: "progress", message: "Writing the conversation…" });
        const sourceText = body.sourceText?.trim() || `A focused discussion about: ${title}`;
        const dialogue = await generatePodcastDialogue(title, sourceText, undefined, length);

        send({ type: "progress", message: `Voicing ${dialogue.turns.length} lines with ElevenLabs…` });
        const mp3 = await buildPodcastEpisode(dialogue.turns);

        send({
          type: "done", success: true,
          episodeTitle: dialogue.episodeTitle,
          turns: dialogue.turns,
          audioBase64: mp3.toString("base64"),
          length,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Podcast test failed.";
        console.error(`[generate-podcast-test] ${msg}`);
        send({ type: "error", message: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
