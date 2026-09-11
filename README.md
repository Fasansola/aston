# Aston blog tool

Automated content pipeline for [aston.ae](https://aston.ae): topics go in, fully written and QA-checked WordPress drafts come out, with optional images, read-aloud audio, a YouTube video, a two-host podcast episode and social cross-posts. Runs on Vercel (Next.js 16, Workflow DevKit), OpenAI, Upstash Redis and the WordPress REST API.

Production: `app.aston.ae` (Vercel project `aston`). Pushing to `main` deploys straight to production.

## How a post gets written

1. **Queue** — add a topic on the dashboard (`/`), optionally with an exact generation time, audience, jurisdictions, language and media outputs.
2. **Dispatch** — the daily cron (`/api/cron`, 08:00 UTC) or a per-item timer (`scheduleGeneration` workflow) runs a **pre-flight check** (OpenAI credits, storage, token budget) and starts the durable `generatePost` workflow.
3. **Pipeline** (each stage is a checkpointed Workflow step, resumable after a function kill): research → strategy brief → title engine + blueprint → authority links → article → link scrubbing → image briefs (one per image slot, anchored to the text beside it) → QA (up to 3 passes, targeted fixes) → WordPress draft.
4. **Media** — the `generateMedia` workflow adds article images, and any requested audio / video / podcast, after the draft exists.
5. **Go live** — approved drafts are scheduled in the publish queue and cross-posted to social targets.

Failures are recorded on the queue item in plain English with a next action, in the run log, and (once configured) sent as an alert.

## Article images

Each post carries four generated pictures, and the page template fixes where they sit: the **hero** under the title, **keypoint 1** beside the first pull-out sentence after the introduction, the **split** image after the Aston VIP section and its closing quote (just before the FAQ), and **keypoint 2** beside the second pull-out sentence between the FAQ and the final points. `lib/imageBrief.ts` turns the finished article into one brief per slot: the exact sentence or quote beside the picture, what the reader has just read, and what comes next. `generateImagePrompts` (`lib/openai.ts`) then asks the model, as an art director, for a concept per slot (the specific idea from that text), a different visual approach for each of the four (place, human moment, object detail, concept made physical, process made physical), and a 45 to 80 word photographic brief.

Hard limits on the set: at most one office interior, no "binders on a desk in front of a skyline window", at most one two-people-at-a-table scene, legible in-scene text in at most one image, never overlaid text, logos, flags or coins. `assessPromptDiversity` checks the draft for those patterns and for two prompts that describe the same picture; a flagged draft is sent back to the model once with the reasons. The four concepts of the last twelve posts are kept in Redis (`aston:image_concepts`) and passed to the next article as "already used", so consecutive posts on the same theme stop converging on one photograph.

The scheduled pipeline renders the briefs the generation run wrote (they are passed into the media workflow with the article), so the pictures match the alt text the article was checked with. The Recent posts tab shows "What the four images show" for every post. To re-image an existing post, open Add media for it and tick Article images: the briefs are rebuilt from the post's own text, including its pull-out sentences and quotes.

**Video scene images** get the same treatment (`briefSceneImages` in `lib/videoScript.ts`, run right after scene segmentation). Each of the seven stills is briefed from the narration heard while it is on screen, with the frame's constraints spelled out: the picture sits in a tall panel on the right, zoomed and tinted, with subtitles along the bottom, so the subject is centred and the photograph carries no readable text at all (the video renders its own). Set-level limits: at most two office interiors, two two-people-at-a-table scenes, one screen-led image with no interface, no binders-on-a-desk-with-skyline, and no approach used twice in a row. The same diversity check runs with those limits and asks for one revision; the last seven videos' scene concepts are kept in Redis (`aston:video_scene_concepts`) as "already used". If the art-direction pass fails, the segmentation's own first-draft prompts are used.

## Saved progress (nothing generated is lost)

Every stage of a generation is written to a draft store as it completes (`lib/drafts.ts`, Redis key `aston:draft:item:<queueItemId>`, kept 14 days): the resolved title, research, links, source brief, strategy, blueprint, authority links, the article after each QA pass with the QA verdict, the image briefs, and the WordPress post id once created. A new run for the same queue item (Retry now, the watchdog, the daily cron) resumes from whatever is there: planning is reused, an article that already passed QA goes straight to publish, and a post that was already created is reused rather than duplicated. The draft is ignored when the item's topic, instructions, source text or settings change (an input signature is stored with it).

The queue row shows "Saved progress: <stage> · Open ↗ · Discard". Open renders the saved article with its image briefs and a **Copy article HTML** button, so a piece can be pasted into WordPress by hand if the site stays unreachable; Discard forgets the progress so the next run starts clean. The same page is `GET /api/queue/draft?id=<itemId>&format=html`; without `format` it returns the draft as JSON.

Article images are staged too: `/api/generate-images` writes each generated image to the Remotion S3 bucket (`article-images/<postId>/<slot>.png`) before uploading it to WordPress, and reuses the staged file on any later attempt. A blocked upload therefore costs a retry, not four more images. Without the S3 env the route behaves as before. Consider an S3 lifecycle rule that expires that prefix after a couple of weeks.

## Crons (vercel.json)

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron-watchdog` | every 30 min | Re-queues items stuck in *processing*, after confirming the workflow run is really dead |
| `/api/links/sync-wp` | 06:00 daily | Refreshes the internal-links pool from WordPress |
| `/api/cron` | 08:00 daily | Daily generation dispatcher |
| `/api/cron-publish` | 09:00 daily | Publishes approved drafts |
| `/api/cron-social-tokens` | 04:00 daily | Refreshes social OAuth tokens |
| `/api/cron-performance` | Mondays 03:00 | Pulls GA4 / Search Console performance |
| `/api/spotify-sync` | hourly | Embeds Spotify players into posts with podcasts |

## Dashboard: System status

The card at the top of the dashboard answers "can a generation succeed right now?" with five lights:

- **OpenAI** — a real, tiny completion. A billing or key problem shows here immediately (listing models succeeds even with zero credits, so a completion is the only honest check).
- **WordPress** — one authenticated REST request. *Warn* when SiteGround's anti-bot challenged it.
- **Storage** — a Redis write.
- **Alerts** — whether a notification channel is configured, with a **Send test alert** button.
- **Usage & budget** — this month's tokens, calls and images, an estimated cost when `OPENAI_PRICING` is set, and the budget position when `OPENAI_MONTHLY_TOKEN_BUDGET` is set.

The same checks run as the cron's pre-flight. If OpenAI, storage or the budget block generation, a daily run is skipped with one alert and the queue is left untouched; a *Run now* / instant item is marked failed with the reason so the dashboard shows it straight away.

## Alerts

Set **one** of these in Vercel → Settings → Environment Variables (Production), then redeploy:

| Channel | Variables |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID` (send the bot a message, then read `https://api.telegram.org/bot<token>/getUpdates`) |
| Slack / Discord / anything | `NOTIFY_WEBHOOK_URL` — an incoming-webhook URL; the payload carries both `text` and `content` |

Without a channel, `notify()` only writes to the Vercel function logs. Use **Send test alert** on the dashboard to confirm delivery.

## Environment variables

Core: `OPENAI_API_KEY`, `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD`, `API_SECRET` (dashboard login), `CRON_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GEMINI_API_KEY` (Imagen).

Reliability and cost (all optional):

| Variable | Effect |
|---|---|
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `NOTIFY_WEBHOOK_URL` | Failure alerts (see above) |
| `OPENAI_PRICING` | JSON price table, USD per 1M tokens, e.g. `{"gpt-5.5":{"input":1.25,"output":10},"gpt-4o":{"input":2.5,"output":10}}`. Enables cost estimates per run and per month. Prices change, so they live here rather than in code. |
| `OPENAI_MONTHLY_TOKEN_BUDGET` | Total tokens per calendar month. Past it, pre-flight blocks new generations until the next month or a higher budget. |
| `MEDIA_LLM_MODEL` | Model for the media pipeline copy (video/HeyGen scripts, YouTube SEO, podcast dialogue). Default `gpt-4o` for latency; set `gpt-5.5` to use the reasoning model there too (temperature is stripped automatically). |
| `OPENAI_MODEL` | Primary chat model for the article pipeline. Default `gpt-6-astra` (requested 2026-09-07). If the account cannot use it, the first call gets a 404, every call for the next ten minutes goes straight to `OPENAI_FALLBACK_MODEL`, and the status card's OpenAI light turns amber with the reason. A wrong model name therefore degrades a run, never fails it. |
| `WP_API_URL` | Base URL for all WordPress REST calls when they should go through the fixed-IP relay (`ops/wp-relay/`), e.g. `https://wp-relay.aston.ae`. Unset = talk to `WP_URL` directly. |
| `WP_RELAY_KEY` | Shared secret the relay requires (`X-Relay-Key`); sent only when `WP_API_URL` is set. Same value as `RELAY_KEY` on the relay. Mark Sensitive. |
| `OPENAI_FALLBACK_MODEL` | Model used when the primary is unavailable or fails twice on transient errors. Default `gpt-5.5`, the last model proven on this account (`gpt-5.3` does not exist here). |
| `WP_API_URL` | Base URL for WordPress REST calls when they must go through a fixed-IP relay. Public links keep using `WP_URL`. See *SiteGround anti-bot*. |

Media and social: ElevenLabs, HeyGen, Remotion/AWS, YouTube, Spotify, Meta, LinkedIn, TikTok, S3 and podcast feed settings. The `/social/connect` page lists what each platform needs.

Token usage is written per run (`aston:usage:run:<runId>`, 90-day TTL) and per month (`aston:usage:month:<YYYY-MM>`) as Redis hashes, and shown in the Recent Runs table and the status card.

## Runbook: "a generation failed"

1. Open the dashboard. The **System status** card tells you whether anything is blocked (OpenAI credits or key, storage, budget) and whether WordPress is currently challenging requests.
2. The failed queue row shows a one-line summary and the next action; **Details** holds the raw error.
3. Common cases:
   - **OpenAI credits exhausted** — top up at platform.openai.com → Settings → Billing and turn on auto-recharge, then *Retry now*. This is what took every generation down from 26 August to 7 September 2026.
   - **OpenAI API key rejected** — fix `OPENAI_API_KEY` in Vercel, redeploy, *Retry now*.
   - **WordPress blocked the connection (SiteGround anti-bot)** — usually clears in minutes; *Retry now*. If it recurs daily, see below.
   - **Generation was interrupted** — the watchdog recovered a dead run; *Retry now*.
   - Anything else twice in a row — send the Details text to the developer. Vercel → Observability → Runtime errors keeps 7 days of grouped errors; raw runtime logs keep 1 day on this plan.

## SiteGround anti-bot

**What the pipeline does about it (since 2026-09-07).** The block hits the WordPress write most often, which is the last step after 10–15 minutes of model work. A blocked post creation no longer fails the run: the article is already checkpointed, so the workflow waits with durable sleeps (3, 5, 8, 12, then 15 minutes, about 43 minutes in all) and publishes again; the queue row and the Generate page show "WordPress is blocking Vercel right now… publishing again in N min". The media workflow does the same for the article images (waits of 5 and 10 minutes, bounded because each attempt regenerates four images). Internal aston.ae links are no longer HEAD-checked against the live site during link scrubbing (they come from the approved list), which also removes a burst of bot-looking requests to the site right before the write.


SiteGround's *Anti-Bot AI* sits in front of WordPress and intermittently answers requests from cloud IP ranges (Vercel's functions share AWS egress IPs with thousands of other apps) with an HTML captcha page instead of JSON. It cannot be switched off in Site Tools and no WordPress plugin can bypass it, because it acts before WordPress runs.

What the code already does: every WordPress request identifies itself with the user-agent **`AstonPublisher/1.0`** (the string SiteGround support asked for, see below; `WP_USER_AGENT` overrides it); every write detects the captcha page and retries with backoff; a persistent block trips a short circuit-breaker so a run fails fast with a clear message instead of burning its time budget; the public podcast feed serves a cached copy and is CDN-cached; the daily link sync has a bigger time budget.

**Ticket history.** A ticket was opened on 7 July 2026 asking to exempt `/wp-json/wp/v2/*` or a custom user-agent. Support (Preslav Peev) replied that they did not see the Vercel IP being blocked at that time, but did see their WAF (rule 900338) rejecting requests from unrelated IPs that used an outdated Chrome user-agent, and asked us to switch to `AstonPublisher/1.0` and test again. Until 7 September 2026 the tool never sent that string (it sent `AstonBlogTool/1.0 …` on some calls and the axios/Node default on others), so that test never happened. The first thing to do is simply run a generation and watch the **WordPress** light on the status card and the `[wordpress]` log lines.

Permanent options, in order of effort:

1. **Follow up on the SiteGround ticket** with evidence from a run made after 7 September 2026 if `sgcaptcha` pages still appear. Point out that the block is the *Anti-Bot AI* challenge page (HTTP 200 with `sgcaptcha` in the body, or a 403 with the same page), not the WAF 403 they quoted, and that every request now carries `AstonPublisher/1.0`. Template:

   > Following up on our ticket of 7 July: all requests from our publishing tool now use the user-agent `AstonPublisher/1.0` as you suggested. On <date, time UTC> a request to `POST /wp-json/wp/v2/posts` (Application Password, from an AWS us-east-1 address used by Vercel) still received the Anti-Bot AI challenge page (`sgcaptcha`) instead of JSON — this is the anti-bot challenge, not the WAF rule 900338 from your earlier reply. Please exempt requests carrying this user-agent to `/wp-json/` from the Anti-Bot AI, or tell us which single IP you can whitelist and we will route through it.

2. **Fixed-IP relay + IP whitelist (chosen on 7 September 2026).** SiteGround will whitelist a *single* IP far more readily than a cloud range, and a dedicated address that only ever sends these authenticated requests is unlikely to be challenged at all. `ops/wp-relay/` contains a complete Caddy reverse proxy with an installer and a DigitalOcean recipe: `ops/wp-relay/create-droplet.sh '<key>'` creates a ~$6/month droplet that installs itself at first boot and comes up on `https://<ip-with-dashes>.sslip.io` (no DNS change needed; a real subdomain can be used instead). Then set `WP_API_URL=https://<relay host>` and `WP_RELAY_KEY=<key>` in Vercel and redeploy. Only `/wp-json/*` requests carrying the key are forwarded (everything else is a 404); the key and the `X-Forwarded-*` headers are stripped so WordPress sees plain requests from the relay's address. The status card reads "REST API reachable via relay" when it is in use, and warns if the key is missing. Full steps in `ops/wp-relay/README.md`.

3. **Pull model.** Turn the integration around: a small WordPress plugin polls an authenticated "outbox" on the app every minute and applies posts, media and field updates locally. Outbound requests from SiteGround are never challenged. This removes the dependency entirely but is a larger change (every WordPress write becomes a queued job) and adds up to a minute of latency per publish. Worth it only if options 1 and 2 are refused.

## Local development

`vercel env pull` cannot retrieve the sensitive secrets (`OPENAI_API_KEY`, `API_SECRET`, `ELEVENLABS_API_KEY`, `HEYGEN_API_KEY`), so anything that calls those services cannot run locally; `.env.local` holds placeholders. Everything else (dashboard, storage with the `data/*.json` file fallback, ffmpeg rendering, unit tests) works with `npm run dev`. Verify AI features by pushing to `main` and using the deployed app.

Note that Vercel's function runtime ships ffmpeg 7.0.2 while `ffmpeg-static` locally is 6.0; 7.0.2's filtergraph parser is stricter (single filterchain, no `;` or named labels).

## Tests and CI

```bash
npm test            # vitest: error classification, LLM helper, QA engine
npx tsc --noEmit    # typecheck
npm run build       # full Next build (what CI runs before main deploys)
```

CI (`.github/workflows`) runs typecheck, unit tests and a full build on every push to `main`. The build only needs the env vars to exist, so CI stubs them.
