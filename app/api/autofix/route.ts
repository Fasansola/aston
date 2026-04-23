/**
 * app/api/autofix/route.ts
 * POST /api/autofix
 *
 * Applies safe, reversible auto-fixes to article HTML:
 * - Removes bold from body paragraphs
 * - Converts US spellings to British English
 * - Normalises title-case headings to sentence case
 * - Removes decorative symbols
 */

import { NextRequest, NextResponse } from "next/server";
import { applyAutoFixes } from "@/lib/readinessValidator";

export const maxDuration = 15;

function authOk(req: NextRequest): boolean {
  const secret =
    req.headers.get("x-api-secret") ??
    new URL(req.url).searchParams.get("secret");
  return secret === process.env.API_SECRET;
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { html, language } = await req.json();

    if (!html?.trim()) {
      return NextResponse.json({ error: "html is required" }, { status: 400 });
    }

    const result = applyAutoFixes(html, language ?? null);
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("[autofix] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Auto-fix failed" },
      { status: 500 }
    );
  }
}
