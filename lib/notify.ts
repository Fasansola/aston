/**
 * lib/notify.ts
 * ─────────────────────────────────────────────────────────────
 * Failure/alert notifications for headless runs. Channel picked by env:
 *
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  → Telegram message
 *   NOTIFY_WEBHOOK_URL                     → POST JSON webhook
 *                                            (payload carries both `text` and
 *                                            `content`, so a Slack or Discord
 *                                            incoming-webhook URL works as-is)
 *   neither                                → log-only (console.warn)
 *
 * notify() NEVER throws — an alerting failure must not break the pipeline
 * it's reporting on.
 */

export async function notify(subject: string, body: string): Promise<void> {
  const text = body ? `${subject}\n${body}` : subject;
  try {
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat  = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text: text.slice(0, 4000) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.warn(`[notify] Telegram send failed (${res.status})`);
      return;
    }

    const webhook = process.env.NOTIFY_WEBHOOK_URL;
    if (webhook) {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 4000), content: text.slice(0, 1900) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.warn(`[notify] Webhook send failed (${res.status})`);
      return;
    }

    console.warn(`[notify] (no channel configured) ${text.slice(0, 500)}`);
  } catch (err) {
    console.warn(`[notify] Send failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
