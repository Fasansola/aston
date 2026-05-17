import { NextRequest, NextResponse } from "next/server";

const BLOCKED_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254"];

function isAllowedUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (BLOCKED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip HTML tags and collapse whitespace to get readable article text.
 * Preserves paragraph breaks so the extracted content is easy to read.
 */
function extractText(html: string): string {
  return html
    // Remove <script>, <style>, <nav>, <header>, <footer>, <aside> blocks entirely
    .replace(/<(script|style|nav|header|footer|aside|noscript|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Convert block-level elements to newlines
    .replace(/<\/(p|div|li|h[1-6]|blockquote|article|section|tr)>/gi, "\n")
    // Convert <br> to newline
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, "\n\n")
    // Trim each line
    .split("\n").map((l) => l.trim()).join("\n")
    .trim();
}

export async function POST(req: NextRequest) {
  const { url } = await req.json();

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  if (!isAllowedUrl(url)) {
    return NextResponse.json({ error: "Invalid or disallowed URL" }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AstonBlogTool/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return NextResponse.json({ error: `Could not reach URL: ${msg}` }, { status: 502 });
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: `URL returned ${response.status} ${response.statusText}` },
      { status: 502 }
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return NextResponse.json(
      { error: `URL does not return HTML (got ${contentType})` },
      { status: 422 }
    );
  }

  const html = await response.text();
  const text = extractText(html);

  if (text.length < 100) {
    return NextResponse.json(
      { error: "Page returned too little readable content. It may require login or JavaScript." },
      { status: 422 }
    );
  }

  // Cap at ~50k chars to avoid blowing the context window downstream
  const truncated = text.length > 50_000 ? text.slice(0, 50_000) + "\n\n[content truncated]" : text;

  return NextResponse.json({ text: truncated, wordCount: truncated.trim().split(/\s+/).length });
}
