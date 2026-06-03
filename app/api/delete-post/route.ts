/**
 * app/api/delete-post/route.ts
 * ─────────────────────────────────────────────────────────────
 * DELETE /api/delete-post
 *
 * Permanently deletes a WordPress post and all images associated with it.
 * Skips the trash — force=true sends the post straight to permanent deletion.
 *
 * Body: {
 *   postId:        number       — WP post ID
 *   audioMediaId?: number       — WP media ID of the generated audio file (if any)
 *   imageIds: {                 — all 4 images uploaded for this post
 *     keypointOneImg: number
 *     keypointTwoImg: number
 *     postSplitImg:   number
 *     featuredImg:    number
 *   }
 * }
 */

import { NextRequest, NextResponse } from "next/server";

const WP_URL      = process.env.WP_URL!;
const WP_USERNAME = process.env.WP_USERNAME!;
const WP_APP_PASS = process.env.WP_APP_PASSWORD!;
const WP_AUTH     = Buffer.from(`${WP_USERNAME}:${WP_APP_PASS}`).toString("base64");
const WP_HEADERS  = {
  Authorization:  `Basic ${WP_AUTH}`,
  "Content-Type": "application/json",
};

function authOk(req: NextRequest): boolean {
  return req.cookies.get("__aston_session")?.value === process.env.API_SECRET;
}

async function wpDelete(endpoint: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/${endpoint}?force=true`, {
    method:  "DELETE",
    headers: WP_HEADERS,
    signal:  AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status };
}

export async function DELETE(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { postId?: number; audioMediaId?: number; imageIds?: Record<string, number> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { postId, audioMediaId, imageIds } = body;

  if (!postId) {
    return NextResponse.json({ error: "postId is required" }, { status: 400 });
  }

  console.log(`[delete-post] Starting deletion — postId=${postId}, audioMediaId=${audioMediaId ?? "none"}, images=${JSON.stringify(imageIds ?? {})}`);

  const errors: string[] = [];

  // Delete the post first
  const postResult = await wpDelete(`posts/${postId}`).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Post ${postId}: ${msg}`);
    console.error(`[delete-post] Post ${postId} deletion threw: ${msg}`);
    return { ok: false, status: 0 };
  });

  if (!postResult.ok && postResult.status !== 404) {
    // 404 means it's already gone — treat as success
    const msg = `Post deletion failed (HTTP ${postResult.status})`;
    errors.push(msg);
    console.error(`[delete-post] ${msg}`);
  } else {
    console.log(`[delete-post] Post ${postId} deleted (status=${postResult.status})`);
  }

  // Delete each image — continue even if one fails
  if (imageIds) {
    const ids = [
      imageIds.keypointOneImg,
      imageIds.keypointTwoImg,
      imageIds.postSplitImg,
      imageIds.featuredImg,
    ].filter((id): id is number => typeof id === "number" && id > 0);

    // Deduplicate in case any IDs were reused
    const uniqueIds = [...new Set(ids)];
    console.log(`[delete-post] Deleting ${uniqueIds.length} image(s): ${uniqueIds.join(", ")}`);

    await Promise.all(
      uniqueIds.map(async (id) => {
        const result = await wpDelete(`media/${id}`).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`Image ${id}: ${msg}`);
          console.error(`[delete-post] Image ${id} deletion threw: ${msg}`);
          return { ok: false, status: 0 };
        });
        if (!result.ok && result.status !== 404) {
          const msg = `Image ${id} deletion failed (HTTP ${result.status})`;
          errors.push(msg);
          console.error(`[delete-post] ${msg}`);
        } else {
          console.log(`[delete-post] Image ${id} deleted (status=${result.status})`);
        }
      })
    );
  }

  // Delete audio file if one was generated
  if (audioMediaId && audioMediaId > 0) {
    console.log(`[delete-post] Deleting audio media ${audioMediaId}`);
    const audioResult = await wpDelete(`media/${audioMediaId}`).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Audio ${audioMediaId}: ${msg}`);
      console.error(`[delete-post] Audio ${audioMediaId} deletion threw: ${msg}`);
      return { ok: false, status: 0 };
    });
    if (!audioResult.ok && audioResult.status !== 404) {
      const msg = `Audio deletion failed (HTTP ${audioResult.status})`;
      errors.push(msg);
      console.error(`[delete-post] ${msg}`);
    } else {
      console.log(`[delete-post] Audio ${audioMediaId} deleted (status=${audioResult.status})`);
    }
  }

  const success = errors.length === 0;
  console.log(`[delete-post] Complete — success=${success}${errors.length ? `, errors: ${errors.join("; ")}` : ""}`);

  return NextResponse.json({
    success,
    deletedPost:   postId,
    deletedImages: imageIds ? Object.values(imageIds).filter(Boolean).length : 0,
    deletedAudio:  audioMediaId ? 1 : 0,
    errors,
  });
}
