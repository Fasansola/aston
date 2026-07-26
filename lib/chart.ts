/**
 * lib/chart.ts
 * ─────────────────────────────────────────────────────────────
 * Post-hoc chart generation for an already-published article.
 *
 * During normal generation the model embeds an `aston-chart-block` directly in
 * the body. When its data is malformed, sanitizeChartBlocks() drops the block
 * and the post ships chart-less. This module rebuilds one chart from the
 * finished article text: a single JSON-returning LLM call → a clean, on-brand
 * chart block that the live theme's Chart.js renderer can draw. We ask the
 * model for structured data (not raw HTML) and assemble the markup ourselves,
 * so the output is predictable and always passes the same sanitiser the main
 * generation pipeline uses.
 */

import OpenAI from "openai";
import { chatWithRetry, assertCompleted, extractJson } from "./llm";
import { sanitizeChartBlocks } from "./chartSanitizer";

// Aston gold palette — one colour per data point, cycled for longer series.
const PALETTE = ["#C9A84C", "#B8963E", "#8B7536", "#5a4a2f", "#D4B86A", "#E8C96A"];

const CHART_TYPES = ["bar", "horizontalBar", "pie", "doughnut"] as const;
type ChartType = (typeof CHART_TYPES)[number];

interface ChartSpec {
  title: string;
  subtitle: string;
  type: ChartType;
  labels: string[];
  values: number[];
  datasetLabel: string;
}

const escText = (s: string) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").trim();

// Labels live inside a single-quoted JSON attribute that the sanitiser
// re-stringifies; strip quotes so neither the JSON nor the attribute breaks.
const cleanLabel = (s: string) => String(s ?? "").replace(/['"]/g, "").trim();

const stripTags = (html: string | undefined) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function buildChartHtml(spec: ChartSpec): string {
  const n = Math.min(spec.labels.length, spec.values.length);
  const labels = spec.labels.slice(0, n).map(cleanLabel);
  const values = spec.values.slice(0, n);
  const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
  const type: ChartType = CHART_TYPES.includes(spec.type) ? spec.type : "bar";
  return `<div class="aston-chart-block">
  <h4 class="aston-chart-block__title">${escText(spec.title)}</h4>
  <p class="aston-chart-block__subtitle">${escText(spec.subtitle)}</p>
  <canvas
    class="aston-chartjs"
    data-chart-type="${type}"
    data-chart-labels='${JSON.stringify(labels)}'
    data-chart-values='${JSON.stringify(values)}'
    data-chart-colors='${JSON.stringify(colors)}'
    data-chart-label="${escText(spec.datasetLabel)}"
    height="220">
  </canvas>
</div>`;
}

export interface ChartSourceContent {
  main_content: string;
  more_content_1?: string;
  more_content_2?: string;
  more_content_3?: string;
  more_content_4?: string;
  more_content_5?: string;
  more_content_6?: string;
  final_points?: string;
}

const SYSTEM_PROMPT =
  `You produce data for ONE chart that visualises a real, comparable dataset drawn from a given article. ` +
  `Ground every number in the article's own facts (fees, timelines, rankings, rates, counts, proportions). ` +
  `Never invent data the article does not support — if the article has no direct comparison, derive a ` +
  `defensible one from the concrete figures it does state. Return ONLY a JSON object.`;

function userPrompt(articleText: string, meta: { title: string; focusKeyword?: string }): string {
  return `ARTICLE TITLE: ${meta.title}
${meta.focusKeyword ? `FOCUS KEYWORD: ${meta.focusKeyword}\n` : ""}
ARTICLE TEXT:
${articleText}

Return a JSON object describing ONE chart that a reader of THIS article would find genuinely useful, with these exact keys:
{
  "title": "specific chart title relevant to this article",
  "subtitle": "one sentence describing what the chart shows",
  "type": "bar | horizontalBar | pie | doughnut (bar = side-by-side comparison, horizontalBar = ranked list, pie/doughnut = proportions)",
  "labels": ["short label", "short label", ...],
  "values": [number, number, ...],
  "datasetLabel": "short dataset description"
}

Rules:
- values MUST be plain numbers only — no thousands separators, no %, no currency symbols, no units, no quotes (write 15000 not "15,000", 9 not "9%")
- labels and values MUST have the same number of elements (3–6 items)
- labels are short plain strings with NO apostrophes or double quotes
- Base every value on the article's actual content.`;
}

async function runChartCall(openai: OpenAI, user: string): Promise<ChartSpec> {
  const res = await chatWithRetry(
    openai,
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      max_completion_tokens: 2000,
    },
    { label: "generateChartBlock", timeoutMs: 90_000 },
  );
  const raw = assertCompleted(res, "generateChartBlock");
  const spec = extractJson<Partial<ChartSpec>>(raw, "generateChartBlock");
  return {
    title: String(spec.title ?? "").trim() || "At a glance",
    subtitle: String(spec.subtitle ?? "").trim(),
    type: (spec.type as ChartType) ?? "bar",
    labels: Array.isArray(spec.labels) ? spec.labels.map(String) : [],
    values: Array.isArray(spec.values)
      ? spec.values.map((v) => (typeof v === "number" ? v : parseFloat(String(v)))).filter((v) => Number.isFinite(v))
      : [],
    datasetLabel: String(spec.datasetLabel ?? "").trim(),
  };
}

/**
 * Generate a single, sanitised aston-chart-block from a finished article.
 * Returns the HTML block, or throws if the model can't produce chart data that
 * survives sanitizeChartBlocks() — even after one sharper retry.
 */
export async function generateChartBlock(
  content: ChartSourceContent,
  meta: { title: string; focusKeyword?: string },
): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const articleText = [
    content.main_content, content.more_content_1, content.more_content_2,
    content.more_content_3, content.more_content_4, content.more_content_5,
    content.more_content_6, content.final_points,
  ].map(stripTags).filter(Boolean).join("\n\n").slice(0, 12_000);

  if (!articleText.trim()) throw new Error("This post has no readable content to build a chart from");

  const user = userPrompt(articleText, meta);

  let block = sanitizeChartBlocks(buildChartHtml(await runChartCall(openai, user)));
  if (!block.trim()) {
    // First spec's data was unsalvageable — retry once with a sharper nudge.
    const retryUser = user + `\n\nYour previous attempt produced unusable numbers. Return clean integer or decimal values only, 3–6 items, with matching labels.`;
    block = sanitizeChartBlocks(buildChartHtml(await runChartCall(openai, retryUser)));
  }
  if (!block.trim()) throw new Error("Could not derive valid chart data from this article");
  return block;
}
