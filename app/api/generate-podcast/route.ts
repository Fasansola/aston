/**
 * app/api/generate-podcast/route.ts
 * ─────────────────────────────────────────────────────────────
 * POST /api/generate-podcast  { postId, title?, focusKeyword? }
 *
 * Produces the conversational (two-voice) podcast episode for a post:
 *   1. Assemble the article text from WordPress
 *   2. Write a host/expert dialogue (lib/podcastDialogue)
 *   3. Voice it with ElevenLabs (two voices) + music sting (lib/podcastAudio)
 *   4. Upload the MP3 to WP media and save it to ACF `podcast_audio_url`
 *
 * The podcast RSS feed serves `podcast_audio_url` in preference to the blog
 * read-aloud `audio_url`. Streams SSE progress events.
 */

import { NextRequest } from "next/server";
import { generatePodcastDialogue } from "@/lib/podcastDialogue";
import { buildPodcastEpisode } from "@/lib/podcastAudio";
import { uploadMediaToWordPress, patchWordPressContentField } from "@/lib/wordpress";

export const maxDuration = 300;

function stripHtml(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Pull the article text from WordPress (public context) to feed the dialogue. */
async function fetchSourceText(postId: number): Promise<{ title: string; text: string }> {
  const res = await fetch(
    `${process.env.WP_URL}/wp-json/wp/v2/posts/${postId}?_fields=title,content,acf`,
    { signal: AbortSignal.timeout(20_000) }
  );
  if (!res.ok) throw new Error(`Could not load post ${postId} from WordPress (${res.status})`);
  const post = await res.json() as { title?: { rendered?: string }; content?: { rendered?: string }; acf?: Record<string, unknown> };
  const acf = post.acf ?? {};
  const parts = [
    post.content?.rendered ?? "",
    acf.more_content_1, acf.more_content_2, acf.more_content_3,
    acf.more_content_4, acf.more_content_5, acf.more_content_6,
    acf.Final_Points,
  ].filter((p) => typeof p === "string") as string[];
  return {
    title: stripHtml(post.title?.rendered ?? ""),
    text: parts.map(stripHtml).filter(Boolean).join("\n\n"),
  };
}

export async function POST(req: NextRequest) {
  let body: { postId?: number; title?: string; focusKeyword?: string };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 }); }

  const { postId, title: titleHint, focusKeyword } = body;
  if (!postId || typeof postId !== "number") {
    return new Response(JSON.stringify({ error: "postId is required." }), { status: 400 });
  }
  const missing = ["ELEVENLABS_API_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    return new Response(JSON.stringify({ error: `Podcast audio not configured. Missing: ${missing.join(", ")}` }), { status: 503 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: Record<string, unknown>) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        send({ type: "progress", message: "Reading the article…" });
        const { title, text } = await fetchSourceText(postId);
        if (!text || text.length < 200) throw new Error("Article has too little text to build a conversation.");

        send({ type: "progress", message: "Writing the conversation…" });
        const dialogue = await generatePodcastDialogue(titleHint?.trim() || title, text, focusKeyword);

        send({ type: "progress", message: `Voicing ${dialogue.turns.length} lines with two voices…` });
        const mp3 = await buildPodcastEpisode(dialogue.turns);

        send({ type: "progress", message: "Uploading episode to WordPress…" });
        const slug = (title || `post-${postId}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        const { url } = await uploadMediaToWordPress(mp3, `${slug}-podcast.mp3`, "audio/mpeg");
        await patchWordPressContentField(postId, "podcast_audio_url", url);

        send({ type: "done", success: true, podcastUrl: url, episodeTitle: dialogue.episodeTitle, turns: dialogue.turns.length });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Podcast generation failed.";
        console.error(`[generate-podcast] ${msg}`);
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
