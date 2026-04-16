/**
 * lib/gsc.ts
 * ─────────────────────────────────────────────────────────────
 * Google Search Console API wrapper.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — service account email
 *   GOOGLE_PRIVATE_KEY            — private key (replace literal \n with newlines)
 *   GSC_SITE_URL                  — e.g. "sc-domain:aston.ae" or "https://aston.ae/"
 *
 * Service account must have "Owner" or "Full" permission in GSC.
 */

import { google } from "googleapis";

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY");

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
}

export interface GSCMetrics {
  clicks: number;
  impressions: number;
  ctr: number;       // percentage, e.g. 4.2
  avgPosition: number;
}

/**
 * Fetch aggregated GSC metrics for a specific page URL over the last `days`.
 * Returns null if the page has no data in the period.
 */
export async function fetchGSCData(pageUrl: string, days = 90): Promise<GSCMetrics | null> {
  const siteUrl = process.env.GSC_SITE_URL;
  if (!siteUrl) throw new Error("Missing GSC_SITE_URL");

  const auth = getAuth();
  const sc = google.searchconsole({ version: "v1", auth });

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const res = await sc.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ["page"],
      dimensionFilterGroups: [{
        filters: [{
          dimension: "page",
          operator: "equals",
          expression: pageUrl,
        }],
      }],
    },
  });

  const row = res.data.rows?.[0];
  if (!row) return null;

  return {
    clicks:      row.clicks      ?? 0,
    impressions: row.impressions  ?? 0,
    ctr:         (row.ctr        ?? 0) * 100,
    avgPosition: row.position     ?? 0,
  };
}
