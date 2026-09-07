/**
 * app/api/queue/draft/route.ts
 * ─────────────────────────────────────────────────────────────
 * GET    /api/queue/draft?id=<queueItemId>            — the saved draft (JSON)
 * GET    /api/queue/draft?id=<queueItemId>&format=html — readable page with a
 *                                                        "copy article HTML" button
 * DELETE /api/queue/draft?id=<queueItemId>            — discard it (next run starts clean)
 *
 * `key=<draftKey>` is accepted in place of `id` for drafts not tied to a
 * queue item. Session-protected by proxy.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { loadDraft, deleteDraft, mirrorDraftOnItem } from "@/lib/drafts";
import { assembleArticleHtml, DRAFT_STAGE_LABELS, type DraftStage } from "@/lib/draftCore";
import { getQueueItem } from "@/lib/storage";

function keyFrom(req: NextRequest): { key: string; itemId: string | null } | null {
  const id = req.nextUrl.searchParams.get("id");
  const key = req.nextUrl.searchParams.get("key");
  if (id) return { key: `item:${id}`, itemId: id };
  if (key) return { key, itemId: null };
  return null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(req: NextRequest) {
  const ref = keyFrom(req);
  if (!ref) return NextResponse.json({ error: "Provide id or key" }, { status: 400 });
  const draft = await loadDraft(ref.key);
  if (!draft) return NextResponse.json({ error: "No saved draft for this item" }, { status: 404 });

  if (req.nextUrl.searchParams.get("format") !== "html") {
    return NextResponse.json({ draft }, { headers: { "Cache-Control": "no-store" } });
  }

  const item = ref.itemId ? await getQueueItem(ref.itemId) : null;
  const c = draft.content;
  const articleHtml = c ? assembleArticleHtml(c) : "";
  const stage = DRAFT_STAGE_LABELS[draft.stage as DraftStage] ?? draft.stage;
  const title = c?.seo_title || draft.title || item?.topic || "Saved draft";
  const p = draft.imagePrompts;
  const briefs = p ? [
    ["Hero", p.featured_img_concept, p.featured_img_prompt, p.featured_img_alt],
    ["Keypoint 1", p.keypoint_one_img_concept, p.keypoint_one_img_prompt, p.keypoint_one_img_alt],
    ["Split", p.post_split_img_concept, p.post_split_img_prompt, p.post_split_img_alt],
    ["Keypoint 2", p.keypoint_two_img_concept, p.keypoint_two_img_prompt, p.keypoint_two_img_alt],
  ] as const : [];

  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — saved draft</title>
<style>
  body{margin:0;background:#f6f4ef;color:#1b1f2a;font:16px/1.6 Georgia,serif}
  .bar{position:sticky;top:0;background:#0f1626;color:#fff;padding:14px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-family:system-ui,sans-serif;font-size:14px}
  .bar b{color:#c9a84c}.bar button{background:#c9a84c;border:0;color:#0f1626;font-weight:700;padding:8px 14px;border-radius:6px;cursor:pointer}
  .bar button:disabled{opacity:.6}.wrap{max-width:860px;margin:0 auto;padding:32px 24px 80px}
  h1{font-size:34px;line-height:1.2;margin:0 0 8px}.meta{color:#5a6070;font-family:system-ui,sans-serif;font-size:13px;margin-bottom:28px}
  article h3{margin-top:36px}.aston-keypoint{border-left:4px solid #c9a84c;padding:10px 16px;background:#fff;font-weight:600}
  .aston-quote{border-left:4px solid #0f1626;margin:24px 0;padding:8px 18px;font-style:italic;background:#fff}
  .briefs{margin-top:48px;font-family:system-ui,sans-serif;font-size:14px}.briefs h2{font-family:Georgia,serif}
  .briefs div{background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:12px 16px;margin-bottom:12px}
  .briefs small{color:#5a6070}.empty{padding:40px;text-align:center;color:#5a6070;font-family:system-ui,sans-serif}
  textarea{position:absolute;left:-9999px}
</style></head><body>
<div class="bar"><span>Saved draft · <b>${esc(stage)}</b> · updated ${esc(draft.updatedAt)}${draft.published?.postId ? ` · WordPress post ${draft.published.postId}` : ""}${draft.lastError ? ` · last error: ${esc(draft.lastError.slice(0, 140))}` : ""}</span>
${articleHtml ? `<button id="copy">Copy article HTML</button><span id="copied" hidden>Copied — paste into the WordPress code editor.</span>` : ""}</div>
<div class="wrap">
<h1>${esc(title)}</h1>
<div class="meta">${c?.focus_keyword ? `Focus keyword: ${esc(c.focus_keyword)} · ` : ""}${c?.slug ? `Slug: ${esc(c.slug)} · ` : ""}${c?.meta_description ? `Meta: ${esc(c.meta_description)}` : ""}</div>
${articleHtml ? `<article>${articleHtml}</article>` : `<p class="empty">The article had not been written yet when this run stopped (stage: ${esc(stage)}). Research and planning are saved and will be reused by the next run.</p>`}
${briefs.length ? `<section class="briefs"><h2>Image briefs</h2>${briefs.map(([label, concept, prompt, alt]) => `<div><b>${label}</b>${concept ? ` — ${esc(concept)}` : ""}<br><small>${esc(prompt ?? "")}</small><br><small>Alt: ${esc(alt ?? "")}</small></div>`).join("")}</section>` : ""}
</div>
<textarea id="src" readonly>${esc(articleHtml)}</textarea>
<script>
  const b=document.getElementById("copy");if(b){b.onclick=async()=>{const t=document.getElementById("src").value;try{await navigator.clipboard.writeText(t)}catch{const s=document.getElementById("src");s.style.position="static";s.select();document.execCommand("copy");s.style.position="absolute"}document.getElementById("copied").hidden=false;b.disabled=true;setTimeout(()=>{b.disabled=false;document.getElementById("copied").hidden=true},4000)}}
</script></body></html>`;
  return new NextResponse(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const ref = keyFrom(req);
  if (!ref) return NextResponse.json({ error: "Provide id or key" }, { status: 400 });
  await deleteDraft(ref.key);
  if (ref.itemId) {
    try { await mirrorDraftOnItem(ref.itemId, null); } catch { /* item may be gone */ }
  }
  return NextResponse.json({ ok: true });
}
