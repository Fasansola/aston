/**
 * app/api/links/languages/route.ts
 * GET /api/links/languages
 *
 * Fetches the live language list from the WordPress site via Polylang's
 * REST API (/wp-json/pll/v1/languages). Used to populate language dropdowns
 * in the UI without hardcoding language options.
 *
 * Returns: { languages: Array<{ code: string; name: string; locale: string }> }
 */

import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

export const revalidate = 3600; // cache for 1 hour at the CDN layer

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export interface SiteLanguage {
  code: string;   // ISO 639-1 e.g. "en", "fr", "de"
  name: string;   // Display name e.g. "English", "Français"
  locale: string; // WordPress locale e.g. "en_US", "fr_FR"
  isDefault: boolean;
}

export async function GET(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const WP_URL      = process.env.WP_URL!;
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

    const raw = res.data as Array<{
      slug?: string;
      locale?: string;
      name?: string;
      is_default?: boolean;
      term_id?: number;
    }>;

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
