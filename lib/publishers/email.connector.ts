import type { PublisherConnector, PublishRequest, PublishResult } from "@/lib/publishers/types";

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_FROM = "noreply@aston.ae";

export default class EmailConnector implements PublisherConnector {
  async validateConfig(config: Record<string, string>): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!config.apiKey) errors.push("apiKey is required");
    if (!config.to) {
      errors.push("to is required");
    } else if (!EMAIL_REGEX.test(config.to)) {
      errors.push("to must be a valid email address");
    }

    return { ok: errors.length === 0, errors };
  }

  async publish(input: PublishRequest): Promise<PublishResult> {
    const { title, html, target, targetConfig: config } = input;

    const from = config.from || DEFAULT_FROM;
    const subject = config.subject || title;

    const body = {
      from,
      to: config.to,
      subject,
      html,
      text: plainTextFromHtml(html),
    };

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          target,
          ok: false,
          status: "failed",
          message: `Resend API failed (${res.status}): ${errText}`,
        };
      }

      const data = await res.json() as { id: string };

      return {
        target,
        ok: true,
        status: "passed",
        message: `Email sent successfully to ${config.to}`,
        platformPostId: data.id,
        technicalDetails: data,
      };
    } catch (e) {
      return {
        target,
        ok: false,
        status: "failed",
        message: `Unexpected error: ${String(e)}`,
      };
    }
  }
}
