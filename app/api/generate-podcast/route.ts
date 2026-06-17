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
import { uploadMediaToWordPress } from "@/lib/wordpress";
import { getPodcastConfig } from "@/lib/podcast";

export const maxDuration = 300;

const WP_AUTH = Buffer.from(
  `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
).toString("base64");

function stripHtml(html: string): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Create a published episode in the podcast custom post type, with the MP3 in
 * its ACF audio field. Requires the WP API user to have create rights on the
 * CPT (register it with capability_type 'post' + map_meta_cap, or grant caps).
 */
async function createPodcastEpisode(
  cptRestBase: string,
  audioField: string,
  episode: { title: string; description: string; audioUrl: string }
): Promise<{ id: number; link: string }> {
  const res = await fetch(`${process.env.WP_URL}/wp-json/wp/v2/${cptRestBase}`, {
    method: "POST",
    headers: { Authorization: `Basic ${WP_AUTH}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: episode.title,
      content: episode.description,
      status: "publish",
      acf: { [audioField]: episode.audioUrl },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Could not create podcast episode (${res.status}): ${err.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const body = await res.text();
    const hint = body.includes("sgcaptcha") ? " (SiteGround anti-bot is blocking Vercel — exclude /wp-json/ in SiteGround Site Tools → Security → Anti-Bot AI Protection)" : "";
    throw new Error(`Could not create podcast episode — WordPress returned non-JSON (${ct})${hint}`);
  }
  const created = await res.json();
  return { id: created.id, link: created.link };
}

/** Pull the article text from WordPress to feed the dialogue. Authenticated so
 * it can read draft posts (the pipeline saves posts as drafts for review). */
async function fetchSourceText(postId: number): Promise<{ title: string; text: string }> {
  const res = await fetch(
    `${process.env.WP_URL}/wp-json/wp/v2/posts/${postId}?_fields=title,content,acf`,
    { headers: { Authorization: `Basic ${WP_AUTH}` }, signal: AbortSignal.timeout(20_000) }
  );
  if (!res.ok) throw new Error(`Could not load post ${postId} from WordPress (${res.status})`);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const body = await res.text();
    const hint = body.includes("sgcaptcha") ? " (SiteGround anti-bot is blocking Vercel — exclude /wp-json/ in SiteGround Site Tools → Security → Anti-Bot AI Protection)" : "";
    throw new Error(`Could not load post ${postId} — WordPress returned non-JSON (${ct})${hint}`);
  }
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
  let body: { postId?: number; title?: string; focusKeyword?: string; ttsProvider?: string };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid request body." }), { status: 400 }); }

  const { postId, title: titleHint, focusKeyword } = body;
  if (!postId || typeof postId !== "number") {
    return new Response(JSON.stringify({ error: "postId is required." }), { status: 400 });
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    return new Response(JSON.stringify({ error: "Podcast audio not configured. Missing: ELEVENLABS_API_KEY" }), { status: 503 });
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
        const dialogue = await generatePodcastDialogue(
          titleHint?.trim() || title, text, focusKeyword, "medium"
        );

        send({ type: "progress", message: `Voicing ${dialogue.turns.length} lines with ElevenLabs…` });
        const mp3 = await buildPodcastEpisode(dialogue.turns);

        send({ type: "progress", message: "Uploading episode audio…" });
        const slug = (title || `post-${postId}`).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        const { id: audioMediaId, url } = await uploadMediaToWordPress(mp3, `${slug}-podcast.mp3`, "audio/mpeg");

        send({ type: "progress", message: "Publishing episode to the podcast…" });
        const cfg = getPodcastConfig();
        const description = (text.slice(0, 480).trim()) + (text.length > 480 ? "…" : "");
        const episode = await createPodcastEpisode(cfg.cptRestBase, cfg.audioField, {
          title: dialogue.episodeTitle,
          description,
          audioUrl: url,
        });

        // Return the CPT episode id + audio media id so deleting the source post
        // can also remove the podcast episode (parity with YouTube cleanup).
        send({
          type: "done", success: true,
          podcastUrl: url, episodeUrl: episode.link,
          podcastEpisodeId: episode.id, podcastAudioMediaId: audioMediaId,
          episodeTitle: dialogue.episodeTitle, turns: dialogue.turns.length,
        });
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
