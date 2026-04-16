/**
 * lib/ga4.ts
 * ─────────────────────────────────────────────────────────────
 * Google Analytics 4 Data API wrapper.
 *
 * Required env vars (all optional — GA4 sync is skipped if absent):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — same service account as GSC
 *   GOOGLE_PRIVATE_KEY            — same private key
 *   GA4_PROPERTY_ID               — numeric property ID, e.g. "123456789"
 *
 * Service account must have "Viewer" role on the GA4 property.
 */

import { google } from "googleapis";

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY");

  return new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
}

export interface GA4Metrics {
  pageviews: number;
  sessions: number;
  avgTimeOnPage: number; // seconds
  bounceRate: number;    // percentage e.g. 48.2
}

/**
 * Fetch GA4 metrics for a page path over the last `days`.
 * Returns null if GA4_PROPERTY_ID is not configured or the page has no data.
 */
export async function fetchGA4Data(pagePath: string, days = 90): Promise<GA4Metrics | null> {
  if (!process.env.GA4_PROPERTY_ID) return null;

  const auth = getAuth();
  const analyticsdata = google.analyticsdata({ version: "v1beta", auth });

  const res = await analyticsdata.properties.runReport({
    property: `properties/${process.env.GA4_PROPERTY_ID}`,
    requestBody: {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
      dimensions: [{ name: "pagePath" }],
      metrics: [
        { name: "screenPageViews" },
        { name: "sessions" },
        { name: "averageSessionDuration" },
        { name: "bounceRate" },
      ],
      dimensionFilter: {
        filter: {
          fieldName: "pagePath",
          stringFilter: { matchType: "EXACT", value: pagePath },
        },
      },
    },
  });

  const row = res.data.rows?.[0];
  if (!row) return null;

  return {
    pageviews:     parseInt(row.metricValues?.[0]?.value ?? "0"),
    sessions:      parseInt(row.metricValues?.[1]?.value ?? "0"),
    avgTimeOnPage: parseFloat(row.metricValues?.[2]?.value ?? "0"),
    bounceRate:    parseFloat(row.metricValues?.[3]?.value ?? "0") * 100,
  };
}
