/**
 * /social/connect — plain-English guide for connecting each social platform.
 * Static reference (no data fetching); mirrors the Connections guide so the
 * steps live inside the app next to where accounts are actually connected.
 */

import Link from "next/link";
import StudioNav from "../../components/StudioNav";

type Status = "ready" | "mod" | "review";

interface Platform {
  name: string;
  status: Status;
  statusLabel: string;
  need: string;
  steps?: string[];
  envLabel: string;
  env: Array<{ key: string; note?: string }>;
  footnote?: string;
}

const STATUS_STYLES: Record<Status, string> = {
  ready: "text-emerald-400 border-emerald-400/30 bg-emerald-400/[0.06]",
  mod: "text-amber-400 border-amber-400/30 bg-amber-400/[0.06]",
  review: "text-rose-400 border-rose-400/30 bg-rose-400/[0.06]",
};
const DOT: Record<Status, string> = { ready: "bg-emerald-400", mod: "bg-amber-400", review: "bg-rose-400" };

const PLATFORMS: Platform[] = [
  {
    name: "YouTube",
    status: "ready",
    statusLabel: "Ready — nothing to do",
    need: "nothing. It already uses the same account as your blog videos.",
    envLabel: "Already set",
    env: [{ key: "YOUTUBE_CLIENT_ID" }, { key: "YOUTUBE_CLIENT_SECRET" }, { key: "YOUTUBE_REFRESH_TOKEN" }],
    footnote: "A vertical video under 60 seconds is posted as a Short automatically.",
  },
  {
    name: "Facebook",
    status: "mod",
    statusLabel: "Moderate — needs a Meta app",
    need: "a Facebook Page you manage, plus a Meta developer app.",
    steps: [
      "Go to developers.facebook.com and create an app of type Business.",
      "Add the permissions pages_manage_posts and pages_read_engagement.",
      "Copy your Page's numeric ID and generate a Page access token.",
      "Put both into the keys below and redeploy.",
    ],
    envLabel: "Set these",
    env: [{ key: "FACEBOOK_PAGE_ID" }, { key: "FACEBOOK_PAGE_ACCESS_TOKEN" }],
  },
  {
    name: "Instagram",
    status: "mod",
    statusLabel: "Moderate — same Meta app",
    need: "an Instagram Business or Creator account linked to your Facebook Page. Uses the same Meta app as Facebook.",
    steps: [
      "In your Instagram settings, link the account to the Facebook Page.",
      "On the Meta app, add instagram_basic, instagram_content_publish and instagram_manage_comments.",
      "Find your Instagram Business account ID.",
      "Set the ID below. The token can reuse your Facebook Page token, or set its own.",
    ],
    envLabel: "Set these",
    env: [
      { key: "INSTAGRAM_BUSINESS_ACCOUNT_ID" },
      { key: "INSTAGRAM_ACCESS_TOKEN", note: "optional, falls back to the Facebook token" },
    ],
  },
  {
    name: "LinkedIn",
    status: "review",
    statusLabel: "Needs product review",
    need: "a LinkedIn app tied to your Company Page. LinkedIn's review can take a few days, so start early.",
    steps: [
      "Go to linkedin.com/developers and create an app on your Company Page.",
      "Request the products Share on LinkedIn and Community Management API.",
      "Run the sign-in flow to get an access token and a refresh token.",
      "For the author, use urn:li:organization:YOUR_ID to post as the company.",
    ],
    envLabel: "Set these",
    env: [
      { key: "LINKEDIN_CLIENT_ID" },
      { key: "LINKEDIN_CLIENT_SECRET" },
      { key: "LINKEDIN_ACCESS_TOKEN" },
      { key: "LINKEDIN_AUTHOR_URN", note: "urn:li:organization:…" },
    ],
  },
  {
    name: "TikTok",
    status: "review",
    statusLabel: "Needs audit for public posts",
    need: "a TikTok developer app with the Content Posting API.",
    steps: [
      "Go to developers.tiktok.com, create an app and add the Content Posting API.",
      "Verify your media domain — TikTok pulls the reel or images from their URL, so the domain must be approved.",
      "Get an access token and set the keys below.",
    ],
    envLabel: "Set these",
    env: [{ key: "TIKTOK_CLIENT_KEY" }, { key: "TIKTOK_CLIENT_SECRET" }, { key: "TIKTOK_ACCESS_TOKEN" }],
    footnote:
      "Until your app passes TikTok's audit, posts stay private (visible only to you). Public posting unlocks after audit.",
  },
];

const card = "rounded-2xl border border-white/[0.07] bg-white/[0.03] backdrop-blur p-5";

export default function ConnectGuidePage() {
  return (
    <>
      <StudioNav />
      <main className="max-w-3xl mx-auto px-6 pb-24 pt-2 space-y-6">
        <div>
          <p className="text-[11px] uppercase tracking-[0.28em] text-gold/80 font-medium">Aston Social Studio</p>
          <h1 className="font-display text-2xl font-semibold text-white/95 mt-2">Connect your social accounts</h1>
          <p className="text-sm text-white/45 mt-1.5 max-w-2xl">
            A plain-English checklist for hooking up each platform so the Studio can post reels and carousels for you.
            Do them one at a time — none depend on the others.
          </p>
          <Link href="/social" className="inline-block mt-3 text-sm text-gold/80 hover:text-gold underline underline-offset-2">
            ← Back to Social
          </Link>
        </div>

        {/* Two ways to connect */}
        <section className={card}>
          <h2 className="text-xs uppercase tracking-[0.2em] text-white/40 mb-3">Two ways to connect</h2>
          <ol className="space-y-3">
            {[
              <>
                <b className="text-white/85 font-semibold">Set the keys in Vercel.</b> Project <code className="font-mono text-gold text-[13px]">aston</code> → Settings → Environment Variables → add each key below → redeploy.
              </>,
              <>
                <b className="text-white/85 font-semibold">Or paste a token in the app.</b> On the <b className="text-white/80">Connections</b> panel of the <code className="font-mono text-gold text-[13px]">/social</code> page you can drop in a token without touching Vercel.
              </>,
              <>
                <b className="text-white/85 font-semibold">Check status any time.</b> The <code className="font-mono text-gold text-[13px]">/social</code> page shows each platform as connected, or tells you what&apos;s still missing.
              </>,
            ].map((content, i) => (
              <li key={i} className="grid grid-cols-[26px_1fr] gap-3 items-start text-sm text-white/60">
                <span className="w-6 h-6 rounded-md grid place-items-center bg-gold/[0.12] border border-gold/30 text-gold text-xs font-bold tabular-nums">
                  {i + 1}
                </span>
                <span>{content}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Platforms */}
        {PLATFORMS.map((p) => (
          <section key={p.name} className={card}>
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
              <h2 className="text-xl font-bold text-white/95 tracking-tight">{p.name}</h2>
              <span
                className={`inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] font-bold px-2.5 py-1 rounded-full border ${STATUS_STYLES[p.status]}`}
              >
                <span className={`w-2 h-2 rounded-full ${DOT[p.status]}`} />
                {p.statusLabel}
              </span>
            </div>

            <p className="text-sm text-white/50 mb-4">
              <b className="text-white/80 font-semibold">You need:</b> {p.need}
            </p>

            {p.steps && (
              <ol className="space-y-2.5 mb-4">
                {p.steps.map((s, i) => (
                  <li key={i} className="grid grid-cols-[24px_1fr] gap-3 items-start text-sm text-white/70">
                    <span className="w-[22px] h-[22px] rounded-md grid place-items-center border border-gold/30 text-gold text-xs font-bold tabular-nums mt-0.5">
                      {i + 1}
                    </span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            )}

            <div className="rounded-xl border border-white/10 border-l-[3px] border-l-gold/40 bg-black/25 px-4 py-3 overflow-x-auto">
              <div className="text-[10.5px] uppercase tracking-[0.16em] text-white/35 font-bold mb-2">{p.envLabel}</div>
              <ul className="space-y-1.5">
                {p.env.map((e) => (
                  <li key={e.key} className="font-mono text-[13px] text-gold whitespace-nowrap">
                    {e.key}
                    {e.note && <span className="text-white/40"> — {e.note}</span>}
                  </li>
                ))}
              </ul>
            </div>

            {p.footnote && <p className="text-[13px] text-white/45 mt-3">{p.footnote}</p>}
          </section>
        ))}

        {/* Universal notes */}
        <section className="rounded-2xl border border-gold/25 bg-gold/[0.05] p-5">
          <h2 className="text-xs uppercase tracking-[0.2em] text-gold/80 mb-3">Two things that apply to all of them</h2>
          <ul className="space-y-3.5">
            <li className="grid grid-cols-[20px_1fr] gap-3 text-sm text-white/60">
              <span className="text-gold font-bold">→</span>
              <span>
                <b className="text-white/85 font-semibold">Your media must be publicly readable.</b> TikTok, Instagram,
                Facebook and LinkedIn all download the reel or slides from their S3 link, so those files need to be public.
              </span>
            </li>
            <li className="grid grid-cols-[20px_1fr] gap-3 text-sm text-white/60">
              <span className="text-gold font-bold">→</span>
              <span>
                <b className="text-white/85 font-semibold">Give the contact slide a PNG logo.</b> Set{" "}
                <code className="font-mono text-gold text-[13px]">ASTON_LOGO_PNG_URL</code> to a PNG version of the logo.
                The existing logo is an SVG, which the image tool can&apos;t place on the slide.
              </span>
            </li>
          </ul>
        </section>

        <p className="text-[13px] text-white/30 pt-1">
          Set keys in Vercel under project <code className="font-mono text-white/50">aston</code>, then check the{" "}
          <Link href="/social" className="text-gold/70 hover:text-gold underline underline-offset-2">
            Social
          </Link>{" "}
          page to confirm each one shows as connected.
        </p>
      </main>
    </>
  );
}
