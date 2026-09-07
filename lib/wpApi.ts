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
