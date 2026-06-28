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
 */
export function sanitizeChartBlocks(html: string): string {
  if (!html || !html.toLowerCase().includes("aston-chartjs")) return html;

  return html.replace(/<div\b[^>]*class="[^"]*aston-chart-block[^"]*"[^>]*>[\s\S]*?<\/div>/gi, (block) => {
    const canvasMatch = block.match(/<canvas\b[^>]*>/i);
    if (!canvasMatch) return "";              // chart container with no canvas — drop it
    const canvas = canvasMatch[0];

    const readAttr = (name: string): string | null => {
      const m = canvas.match(new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i"));
      return m ? m[2] : null;
    };
    const parseArray = (raw: string | null): unknown[] | null => {
      if (raw == null) return null;
      try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
    };

    const labels = parseArray(readAttr("data-chart-labels"));

    // Clean values: strip thousands commas, then anything that isn't part of a
    // number / array, before parsing.
    let valuesRaw = readAttr("data-chart-values");
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
      .replace(/data-chart-labels\s*=\s*(['"])[\s\S]*?\1/i, `data-chart-labels='${JSON.stringify(labels.slice(0, n))}'`)
      .replace(/data-chart-values\s*=\s*(['"])[\s\S]*?\1/i, `data-chart-values='${JSON.stringify(values.slice(0, n))}'`);

    return block.replace(/<canvas\b[^>]*>/i, fixedCanvas);
  });
}
