import { describe, it, expect } from "vitest";
import { sanitizeChartBlocks, hasEmptyChartCanvas } from "@/lib/chartSanitizer";

// The template the model writes (lib/openai.ts) — an empty canvas.
const MODEL_BLOCK = `<p>Intro.</p><div class="aston-chart-block">
  <p class="aston-chart-block__title">PSD2 initial capital by PI activity</p>
  <p class="aston-chart-block__subtitle">Statutory baselines.</p>
  <canvas
    class="aston-chartjs"
    data-chart-type="bar"
    data-chart-labels='["Money remittance", "Payment initiation", "Other services"]'
    data-chart-values='[20,000, 50000, "125000"]'
    data-chart-colors='["#C9A84C", "#B8963E", "#8B7536"]'
    data-chart-label="Initial capital in EUR"
    height="220">
  </canvas>
</div><p>After.</p>`;

describe("sanitizeChartBlocks", () => {
  it("gives every canvas text fallback content so the WP editor keeps it (post 71641)", () => {
    const out = sanitizeChartBlocks(MODEL_BLOCK);
    expect(out).toContain(
      ">PSD2 initial capital by PI activity: Money remittance 20,000; Payment initiation 50,000; Other services 125,000 (Initial capital in EUR).</canvas>",
    );
    expect(out).toContain(`data-chart-values='[20000,50000,125000]'`);
    expect(hasEmptyChartCanvas(MODEL_BLOCK)).toBe(true);
    expect(hasEmptyChartCanvas(out)).toBe(false);
  });

  it("is idempotent", () => {
    const once = sanitizeChartBlocks(MODEL_BLOCK);
    expect(sanitizeChartBlocks(once)).toBe(once);
  });

  it("reads attributes the WP editor re-serialised with &quot; (post 71210)", () => {
    const saved = `<div class="aston-chart-block">\r\n<h4 class="aston-chart-block__title">Capital</h4>\r\n<canvas class="aston-chartjs" height="220" data-chart-type="bar" data-chart-labels="[&quot;Lower&quot;,&quot;Higher&quot;]" data-chart-values="[2000000,50000000]" data-chart-label="AED"> </canvas>\r\n\r\n</div>`;
    expect(hasEmptyChartCanvas(saved)).toBe(true);
    const out = sanitizeChartBlocks(saved);
    expect(out).toContain(`data-chart-labels='["Lower","Higher"]'`);
    expect(out).toContain(">Capital: Lower 2,000,000; Higher 50,000,000 (AED).</canvas>");
  });

  it("closes a canvas the model left unclosed", () => {
    const out = sanitizeChartBlocks(`<div class="aston-chart-block"><canvas class="aston-chartjs" data-chart-labels='["A"]' data-chart-values='[1]'></div>`);
    expect(out).toBe(`<div class="aston-chart-block"><canvas class="aston-chartjs" data-chart-labels='["A"]' data-chart-values='[1]'>Chart: A 1.</canvas></div>`);
  });

  it("keeps $ and apostrophes in labels intact and the attribute well-formed", () => {
    const out = sanitizeChartBlocks(`<div class="aston-chart-block"><canvas class="aston-chartjs" data-chart-labels="[&quot;$5k plan&quot;,&quot;Owner&#39;s fee&quot;]" data-chart-values='[1,2]'></canvas></div>`);
    expect(out).toContain(`data-chart-labels='["$5k plan","Owner&#39;s fee"]'`);
    expect(out).toContain(">Chart: $5k plan 1; Owner's fee 2.</canvas>");
  });

  it("still drops a block whose data cannot be salvaged", () => {
    expect(sanitizeChartBlocks(`<p>a</p><div class="aston-chart-block"><canvas class="aston-chartjs" data-chart-labels='nope' data-chart-values='[1]'></canvas></div>`)).toBe("<p>a</p>");
  });
});
