/**
 * app/api/links/languages/route.ts
 * GET /api/links/languages
 *
 * Fetches the live language list from the WordPress site via Polylang's
 * REST API (/wp-json/pll/v1/languages). Used to populate language dropdowns
 * in the UI without hardcoding language options.
 *
 * No auth required — language names/codes are not sensitive.
 *
 * Returns: { languages: Array<{ code: string; name: string; locale: string }> }
 */

import { NextResponse } from "next/server";
import axios from "axios";
import { WP_API_BASE } from "@/lib/wpApi";

export const revalidate = 3600; // cache for 1 hour at the CDN layer

export interface SiteLanguage {
  code: string;   // ISO 639-1 e.g. "en", "fr", "de"
  name: string;   // Display name e.g. "English", "Français"
  locale: string; // WordPress locale e.g. "en_US", "fr_FR"
  isDefault: boolean;
}

export async function GET() {
  const WP_URL = WP_API_BASE; // REST base: the site, or the fixed-IP relay when WP_API_URL is set
  const WP_USERNAME = process.env.WP_USERNAME!;
  const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD!;
  const auth = Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

  try {
    const res = await axios.get(`${WP_URL}/wp-json/pll/v1/languages`, {
      headers: {
        Authorization: `Basic ${auth}`,
        "User-Agent": "AstonBlogTool/1.0",
      },
      timeout: 10000,
    });

    // SiteGround's anti-bot can serve an HTML captcha page instead of JSON,
    // in which case res.data is a string — treat any non-array as "no data"
    // instead of crashing on .filter.
    const raw = (Array.isArray(res.data) ? res.data : []) as Array<{
      slug?: string;
      locale?: string;
      name?: string;
      is_default?: boolean;
      term_id?: number;
    }>;
    if (!Array.isArray(res.data)) {
      console.warn(`[languages] Polylang returned non-array (${typeof res.data}) — likely the SiteGround captcha page; returning empty list`);
    }

    const languages: SiteLanguage[] = raw
      .filter((l) => l.slug)
      .map((l) => ({
        code:      l.slug!,
        name:      l.name ?? l.slug!,
        locale:    l.locale ?? l.slug!,
        isDefault: l.is_default ?? false,
      }));

    return NextResponse.json({ languages });

  } catch (err: unknown) {
    console.error("[languages] Failed to fetch from Polylang REST API:", err);
    const msg = axios.isAxiosError(err)
      ? `WordPress API error (${err.response?.status})`
      : err instanceof Error ? err.message : "Failed to fetch languages";
    return NextResponse.json({ error: msg, languages: [] }, { status: 500 });
  }
}
