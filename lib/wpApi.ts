/**
 * lib/wpApi.ts
 * ─────────────────────────────────────────────────────────────
 * Base URL for WordPress REST API calls.
 *
 * WP_URL is the public site (used for edit links, post URLs, display).
 * WP_API_URL, when set, is used for REST calls INSTEAD of WP_URL — this lets
 * API traffic be routed through a fixed-IP relay (a small reverse proxy in
 * front of the same WordPress) that SiteGround support can whitelist, without
 * touching any other code. See README → "SiteGround anti-bot" for the setup.
 */

const strip = (u: string | undefined) => (u ?? "").trim().replace(/\/+$/, "");

/** Public site URL (never the relay). */
export const WP_SITE_URL = strip(process.env.WP_URL);

/** Base URL for /wp-json/ calls: the relay when configured, else the site. */
export const WP_API_BASE = strip(process.env.WP_API_URL) || WP_SITE_URL;

/** True when REST traffic is going through a relay rather than straight to the site. */
export const WP_API_VIA_RELAY = !!strip(process.env.WP_API_URL) && strip(process.env.WP_API_URL) !== WP_SITE_URL;

/**
 * User-Agent for EVERY WordPress REST request.
 *
 * SiteGround support's reply to the anti-bot ticket (2026-07-07) asked for
 * exactly this: "please change the user-agent to AstonPublisher/1.0 and test
 * again". The tool had been sending "AstonBlogTool/1.0 …" on some calls and
 * the axios/Node default on others, so the exemption was never exercised.
 * Override with WP_USER_AGENT only if support asks for a different string.
 */
export const WP_USER_AGENT = process.env.WP_USER_AGENT?.trim() || "AstonPublisher/1.0";
