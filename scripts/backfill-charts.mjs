/**
 * scripts/backfill-charts.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Restores the article charts that the WordPress admin editor wiped.
 *
 * Until 2026-10-04 every chart canvas was written empty, and wp-admin's editor
 * (wpautop + TinyMCE) deletes an empty <canvas> on save — so any post opened
 * and saved in wp-admin kept its chart title/subtitle but lost the canvas and
 * all its data (see lib/chartSanitizer.ts). This script finds those posts on
 * the live site and fixes them through the deployed app (which holds the WP
 * and OpenAI credentials — they can't be pulled locally):
 *
 *   regen   a chart box with no canvas left → POST /api/post-chart { postId }
 *           (one LLM call rebuilds the chart from the article and replaces the
 *           empty box — same as the "Add chart" button on /media)
 *   repair  a working canvas with no text inside → POST /api/post-chart
 *           { postId, repairOnly: true } (no LLM: adds the text fallback that
 *           keeps the canvas safe from the next admin save)
 *
 * Usage:
 *   APP_URL=https://<the tool's production URL> APP_PASSWORD=<tool login password> \
 *     node scripts/backfill-charts.mjs --dry-run      ← list what would change
 *   … node scripts/backfill-charts.mjs                ← fix everything
 *   … node scripts/backfill-charts.mjs --only=regen --limit=5
 *
 * Posts are read from the public WordPress REST API (no credentials needed);
 * only the ACF body sections are checked — the tool never puts charts in the
 * main content.
 * Re-running is safe: fixed posts no longer match either condition.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SITE = (process.env.WP_URL || "https://aston.ae").replace(/\/+$/, "");
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const UA = "AstonPublisher/1.0"; // the user-agent SiteGround lets through

const isDryRun = process.argv.includes("--dry-run");
const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1]; // regen | repair
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

if (!isDryRun && (!APP_URL || !APP_PASSWORD)) {
  console.error("❌  Set APP_URL and APP_PASSWORD (the password you log into the tool with), or pass --dry-run.");
  process.exit(1);
}

const BODY_FIELDS = ["more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"];
const BOX_RE = /<div\b[^>]*class="[^"]*aston-chart-block[^"]*"[^>]*>[\s\S]*?<\/div>/gi;
const textOf = (html) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").trim();

function classify(post) {
  const fields = BODY_FIELDS.map((f) => post.acf?.[f]).filter((v) => typeof v === "string");
  const boxes = fields.flatMap((v) => v.match(BOX_RE) ?? []);
  if (!boxes.length) return null;
  const canvases = boxes.filter((b) => /<canvas\b/i.test(b));
  if (!canvases.length) return { kind: "regen", note: `${boxes.length} empty chart box(es)` };
  const emptyCanvas = canvases.some((b) => {
    const m = b.match(/<canvas\b[^>]*>([\s\S]*?)<\/canvas>/i);
    return !m || !textOf(m[1]);
  });
  if (emptyCanvas || canvases.length < boxes.length) {
    return { kind: "repair", note: `${canvases.length}/${boxes.length} working, needs fallback text${canvases.length < boxes.length ? " + empty box cleanup" : ""}` };
  }
  return null;
}

async function fetchAllPosts() {
  const posts = [];
  for (let page = 1; ; page++) {
    const url = `${SITE}/wp-json/wp/v2/posts?per_page=100&page=${page}&_fields=id,date,link,acf`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 400) break; // past the last page
    if (!res.ok) throw new Error(`WP ${res.status} on page ${page}`);
    // Some old Elementor posts make WordPress print a <style> block ahead of
    // the JSON — skip anything before the array.
    const body = await res.text();
    const batch = JSON.parse(body.slice(body.indexOf("[")));
    posts.push(...batch);
    const totalPages = Number(res.headers.get("x-wp-totalpages") || page);
    process.stdout.write(`\r📥 Read ${posts.length} posts (page ${page}/${totalPages})`);
    if (page >= totalPages) break;
  }
  console.log();
  return posts;
}

async function fix(postId, repairOnly) {
  const res = await fetch(`${APP_URL}/api/post-chart`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `__aston_session=${APP_PASSWORD}` },
    body: JSON.stringify(repairOnly ? { postId, repairOnly: true } : { postId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const posts = await fetchAllPosts();
const todo = posts
  .map((p) => ({ post: p, c: classify(p) }))
  .filter((x) => x.c && (!only || x.c.kind === only))
  .slice(0, limit);

const count = (k) => todo.filter((x) => x.c.kind === k).length;
console.log(`🔎 ${todo.length} post(s) to fix — regen: ${count("regen")}, repair: ${count("repair")}${isDryRun ? "  (dry run)" : ""}\n`);

let ok = 0, failed = 0;
for (const { post, c } of todo) {
  const tag = `${c.kind.padEnd(6)} ${post.id} ${post.date.slice(0, 10)} ${post.link}`;
  if (isDryRun) { console.log(`  ${tag} — ${c.note}`); continue; }
  try {
    const r = await fix(post.id, c.kind === "repair");
    ok++;
    console.log(`✅ ${tag} — ${r.mode} [${(r.fields ?? []).join(", ")}]`);
  } catch (err) {
    failed++;
    console.log(`❌ ${tag} — ${err.message}`);
  }
}
if (!isDryRun) console.log(`\nDone: ${ok} fixed, ${failed} failed.${failed ? " Re-run to retry the failures." : ""}`);
