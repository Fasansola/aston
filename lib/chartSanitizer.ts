/**
 * lib/chartSanitizer.ts
 * ─────────────────────────────────────────────────────────────
 * Pure, dependency-free string helper (no Node modules) so it can be imported
 * into code that runs inside the Workflow DevKit orchestrator without dragging
 * Node-only packages (axios/form-data in lib/wordpress.ts) into that bundle.
 *
 * Repairs (or removes) Chart.js canvas blocks the model produced with bad data.
 * The live site renders `aston-chartjs` canvases from their data-* attributes, so
 * malformed JSON makes a chart silently render nothing. Most common causes:
 *   - thousands-separator commas in values  ([15,000, 25,000] is invalid JSON)
 *   - percent / currency / units inside values
 *   - label and value arrays of different lengths
 * We normalise the numbers, length-match labels/values, rewrite the attributes
 * with clean single-quoted JSON, and drop the whole chart block when the data
 * can't be salvaged (so no blank chart is shown).
 *
 * Every canvas also gets text fallback content (the chart's data in words).
 * An EMPTY canvas does not survive the WordPress admin editor: wpautop wraps it
 * in a <p>, and TinyMCE 4 deletes an empty <canvas> inside a paragraph, leaving
 * <p>&nbsp;</p>. So the first time anyone opened and saved a post in wp-admin,
 * its chart lost all its data and rendered as an empty card (Aug–Oct 2026:
 * ~45 posts). A canvas with text inside is kept, and the text doubles as the
 * chart's accessible description (browsers that draw the canvas don't show it).
 */

const BLOCK_RE = () => /<div\b[^>]*class="[^"]*aston-chart-block[^"]*"[^>]*>[\s\S]*?<\/div>/gi;

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

// JSON for a single-quoted attribute: escape what would end or garble it.
const attrJson = (v: unknown) => JSON.stringify(v).replace(/&/g, "&amp;").replace(/'/g, "&#39;");

const plainText = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function readAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"));
  // TinyMCE re-serialises attributes double-quoted with &quot; inside — decode
  // so data that went through the WP editor still parses.
  return m ? decodeEntities(m[2]) : null;
}

function parseArray(raw: string | null): unknown[] | null {
  if (raw == null) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
}

/** "Title: A 12; B 4; C 1 (Weeks)." — the chart's data in words. */
function fallbackText(block: string, labels: unknown[], values: number[], datasetLabel: string | null): string {
  const titleMatch = block.match(/<(\w+)\b[^>]*class="[^"]*aston-chart-block__title[^"]*"[^>]*>([\s\S]*?)<\/\1>/i);
  const title = titleMatch ? plainText(titleMatch[2]) : "";
  const points = labels
    .map((l, i) => `${plainText(String(l))} ${values[i].toLocaleString("en-US")}`)
    .join("; ");
  const unit = datasetLabel?.trim() ? ` (${plainText(datasetLabel)})` : "";
  return escText(`${title ? `${title}: ` : "Chart: "}${points}${unit}.`);
}

/**
 * Replace the canvas's inner content with `text`. Handles a canvas with no
 * closing tag (the model occasionally omits it) by closing it.
 */
function setCanvasContent(block: string, text: string): string {
  if (/<canvas\b[^>]*>[\s\S]*?<\/canvas>/i.test(block)) {
    return block.replace(/(<canvas\b[^>]*>)[\s\S]*?(<\/canvas>)/i, (_m, open, close) => `${open}${text}${close}`);
  }
  return block.replace(/<canvas\b[^>]*>/i, (open) => `${open}${text}</canvas>`);
}

export function sanitizeChartBlocks(html: string): string {
  if (!html || !html.toLowerCase().includes("aston-chartjs")) return html;

  return html.replace(BLOCK_RE(), (block) => {
    const canvasMatch = block.match(/<canvas\b[^>]*>/i);
    if (!canvasMatch) return "";              // chart container with no canvas — drop it
    const canvas = canvasMatch[0];

    const labels = parseArray(readAttr(canvas, "data-chart-labels"));

    // Clean values: strip thousands commas, then anything that isn't part of a
    // number / array, before parsing.
    let valuesRaw = readAttr(canvas, "data-chart-values");
    if (valuesRaw) {
      let prev: string;
      do { prev = valuesRaw; valuesRaw = valuesRaw.replace(/(\d),(\d{3})(?=\D|$)/g, "$1$2"); } while (valuesRaw !== prev);
      valuesRaw = valuesRaw.replace(/[^\d.,\-[\]\s]/g, "");
    }
    let values = parseArray(valuesRaw) as number[] | null;
    if (values) values = values.map((v) => (typeof v === "number" ? v : parseFloat(String(v)))).filter((v) => Number.isFinite(v));

    // Unsalvageable — remove the whole block so nothing renders blank.
    if (!labels || !values || labels.length === 0 || values.length === 0) return "";

    const n = Math.min(labels.length, values.length);
    const fixedCanvas = canvas
      .replace(/data-chart-labels\s*=\s*(['"])[\s\S]*?\1/i, () => `data-chart-labels='${attrJson(labels.slice(0, n))}'`)
      .replace(/data-chart-values\s*=\s*(['"])[\s\S]*?\1/i, () => `data-chart-values='${attrJson(values.slice(0, n))}'`);

    const fixed = block.replace(/<canvas\b[^>]*>/i, () => fixedCanvas);
    return setCanvasContent(fixed, fallbackText(block, labels.slice(0, n), values.slice(0, n), readAttr(canvas, "data-chart-label")));
  });
}

/**
 * True when a field holds a working chart canvas with no text inside — the
 * shape the WordPress editor deletes on the next admin save.
 */
export function hasEmptyChartCanvas(html: string): boolean {
  if (!html || !html.toLowerCase().includes("aston-chartjs")) return false;
  const blocks = html.match(BLOCK_RE()) ?? [];
  return blocks.some((b) => {
    const m = b.match(/<canvas\b[^>]*>([\s\S]*?)<\/canvas>/i);
    return /<canvas\b/i.test(b) && (!m || !plainText(m[1]));
  });
}
