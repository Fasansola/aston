/**
 * lib/social/reelVideo.ts
 * Turns a reel script into a vertical avatar video:
 *
 *   script → ElevenLabs speech → HeyGen audio-driven avatar (9:16) → S3
 *
 * The render itself runs on HeyGen's infrastructure and takes 3–8 minutes, far
 * longer than a serverless function may live. So this is deliberately a
 * submit-then-check-back design rather than a long-held request:
 *
 *   startReelRender()  — synthesises audio, submits to HeyGen, stores a job.
 *                        Returns in seconds.
 *   checkReelRender()  — one status poll. When HeyGen finishes, the MP4 is
 *                        re-hosted on S3 (HeyGen's own URLs expire) and the job
 *                        is marked done.
 *
 * The client polls checkReelRender until the job is `completed` or `failed`.
 */

import { kget, kset } from "@/lib/storage";
import { generateSpeech, generateSpeechWithTimestamps, type WordTiming } from "@/lib/elevenlabs";
import { createHeyGenVideo, getHeyGenVideoStatus } from "@/lib/heygen";
import { burnCaptions } from "@/lib/social/burnCaptions";
import { uploadAssetToS3 } from "@/lib/sceneImageS3";

export type ReelJobStatus = "processing" | "completed" | "failed";

export interface ReelRenderJob {
  id: string;
  status: ReelJobStatus;
  /** The spoken script this reel was rendered from. */
  script: string;
  title: string;
  /** HeyGen's render id, polled until it completes. */
  heygenVideoId: string;
  /** Whether captions were requested, and word timings to burn them (from ElevenLabs). */
  wantCaptions: boolean;
  words?: WordTiming[];
  /** True once captions have actually been burned into videoUrl. */
  captioned?: boolean;
  /** Permanent S3 URL, set once the render completes and is re-hosted. */
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSecs?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const KEY = "aston:social:reel_jobs";
/** Keep the most recent renders only — this is a working library, not an archive. */
const JOB_LIMIT = 30;

export async function getReelJobs(): Promise<ReelRenderJob[]> {
  return kget<ReelRenderJob[]>(KEY, []);
}

async function saveJob(job: ReelRenderJob): Promise<void> {
  const jobs = await getReelJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx === -1) jobs.unshift(job);
  else jobs[idx] = job;
  await kset(KEY, jobs.slice(0, JOB_LIMIT));
}

export async function getReelJob(id: string): Promise<ReelRenderJob | null> {
  return (await getReelJobs()).find((j) => j.id === id) ?? null;
}

/**
 * Synthesise the narration and submit the avatar render. Returns as soon as
 * HeyGen accepts the job — it does NOT wait for the render.
 */
export async function startReelRender(input: {
  script: string;
  title?: string;
  /** Burn word-synced captions onto the finished reel. Default true. */
  captions?: boolean;
}): Promise<ReelRenderJob> {
  const missing = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "HEYGEN_API_KEY", "HEYGEN_AVATAR_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) throw new Error(`Not configured. Missing: ${missing.join(", ")}`);

  const script = input.script.trim();
  if (!script) throw new Error("script is required");
  const title = (input.title || script.split("\n").find((l) => l.trim()) || "Aston VIP reel").slice(0, 100);
  const wantCaptions = input.captions !== false;

  // 1. Narration — the avatar is lip-synced to THIS audio, not a HeyGen voice.
  //    With captions on, we also capture word timings (they align to the avatar
  //    because it speaks this exact audio) to burn subtitles later.
  let audio: Buffer;
  let words: WordTiming[] | undefined;
  if (wantCaptions) {
    const spoken = await generateSpeechWithTimestamps(script);
    audio = spoken.audio;
    words = spoken.words;
  } else {
    audio = await generateSpeech(script);
  }
  console.log(`[reelVideo] Narration ready — ${(audio.length / 1024).toFixed(1)} KB${words ? `, ${words.length} word timings` : ""}`);

  // 2. Submit the vertical avatar render.
  const heygenVideoId = await createHeyGenVideo(audio, title, "9:16");

  const now = new Date().toISOString();
  const job: ReelRenderJob = {
    id: `reel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    status: "processing",
    script,
    title,
    heygenVideoId,
    wantCaptions,
    words,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job);
  console.log(`[reelVideo] Job ${job.id} submitted — heygen video ${heygenVideoId}`);
  return job;
}

/**
 * One status poll. On completion the MP4 is copied to S3 so the URL keeps
 * working after HeyGen's own link expires. Terminal jobs are returned as-is.
 */
export async function checkReelRender(id: string): Promise<ReelRenderJob | null> {
  const job = await getReelJob(id);
  if (!job) return null;
  if (job.status !== "processing") return job;

  try {
    const res = await getHeyGenVideoStatus(job.heygenVideoId);

    if (res.status === "failed") {
      const failed: ReelRenderJob = {
        ...job,
        status: "failed",
        error: res.error ?? "HeyGen reported a failed render",
        updatedAt: new Date().toISOString(),
      };
      await saveJob(failed);
      return failed;
    }

    if (res.status === "completed" && res.videoUrl) {
      let finalUrl = res.videoUrl;
      let captioned = false;
      // Re-host on S3 — HeyGen's download URLs are short-lived — burning captions
      // in between when requested.
      try {
        const mp4 = await fetch(res.videoUrl, { signal: AbortSignal.timeout(120_000) });
        if (!mp4.ok) throw new Error(`download returned ${mp4.status}`);
        let buf: Buffer = Buffer.from(await mp4.arrayBuffer());

        if (job.wantCaptions && job.words?.length) {
          try {
            buf = await burnCaptions(buf, job.words);
            captioned = true;
            console.log(`[reelVideo] Job ${job.id} captions burned`);
          } catch (e) {
            // Non-fatal: ship the uncaptioned reel rather than lose the render.
            console.warn(`[reelVideo] Job ${job.id} caption burn failed, using uncaptioned video: ${e}`);
          }
        }

        finalUrl = await uploadAssetToS3(buf, `${job.id}.mp4`, "video/mp4", "reels");
        console.log(`[reelVideo] Job ${job.id} re-hosted on S3 (${(buf.length / 1048576).toFixed(1)} MB)`);
      } catch (e) {
        // Keep the HeyGen URL rather than failing the whole job — it still plays,
        // it just expires (and stays uncaptioned). Surfaced so the UI can warn.
        console.warn(`[reelVideo] Job ${job.id} S3 re-host failed, using HeyGen URL: ${e}`);
      }

      const done: ReelRenderJob = {
        ...job,
        status: "completed",
        videoUrl: finalUrl,
        captioned,
        thumbnailUrl: res.thumbnailUrl,
        durationSecs: res.duration,
        words: undefined, // no longer needed once burned — keep the stored job small
        updatedAt: new Date().toISOString(),
      };
      await saveJob(done);
      return done;
    }

    // Still pending/processing — just refresh the timestamp.
    const touched = { ...job, updatedAt: new Date().toISOString() };
    await saveJob(touched);
    return touched;
  } catch (e) {
    // A transient status-check error must not kill the job; the render is still
    // running on HeyGen's side. Leave it processing and let the next poll retry.
    console.warn(`[reelVideo] Status check failed for ${job.id}: ${e}`);
    return job;
  }
}
