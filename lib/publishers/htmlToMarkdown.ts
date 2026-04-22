/**
 * lib/publishers/htmlToMarkdown.ts
 * Minimal HTML → Markdown converter for use in platform connectors.
 * Handles the HTML patterns our content generator produces.
 */

export function htmlToMarkdown(html: string): string {
  return (html ?? "")
    // Block-level elements
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi,   (_, t) => `# ${stripTags(t)}\n\n`)
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi,   (_, t) => `## ${stripTags(t)}\n\n`)
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi,   (_, t) => `### ${stripTags(t)}\n\n`)
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi,   (_, t) => `#### ${stripTags(t)}\n\n`)
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi,   (_, t) => `##### ${stripTags(t)}\n\n`)
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi,   (_, t) => `###### ${stripTags(t)}\n\n`)
    // Lists
    .replace(/<ul[^>]*>/gi, "")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<ol[^>]*>/gi, "")
    .replace(/<\/ol>/gi, "\n")
    .replace(/<li[^>]*>(.*?)<\/li>/gi, (_, t) => `- ${stripTags(t)}\n`)
    // Inline elements
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, (_, t) => `**${t}**`)
    .replace(/<b[^>]*>(.*?)<\/b>/gi,           (_, t) => `**${t}**`)
    .replace(/<em[^>]*>(.*?)<\/em>/gi,         (_, t) => `_${t}_`)
    .replace(/<i[^>]*>(.*?)<\/i>/gi,           (_, t) => `_${t}_`)
    .replace(/<code[^>]*>(.*?)<\/code>/gi,     (_, t) => `\`${t}\``)
    // Links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_, href, text) =>
      href.startsWith("/") ? `[${stripTags(text)}](https://aston.ae${href})` : `[${stripTags(text)}](${href})`
    )
    // Paragraphs and line breaks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi,      "\n\n")
    .replace(/<p[^>]*>/gi,   "")
    .replace(/<\/div>/gi,    "\n")
    .replace(/<div[^>]*>/gi, "")
    // Blockquotes
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) =>
      stripTags(t).split("\n").filter(Boolean).map((l) => `> ${l.trim()}`).join("\n") + "\n\n"
    )
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode HTML entities
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Clean up excess whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(str: string): string {
  return str.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
