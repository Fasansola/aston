/**
 * scripts/youtube-auth.mjs
 * ─────────────────────────────────────────────────────────────
 * One-time script to get a YouTube OAuth 2.0 refresh token.
 * Run this once locally, copy the refresh token to your env vars.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com/apis/library/youtube.googleapis.com
 *      and enable the YouTube Data API v3 for your project.
 *   2. Go to https://console.cloud.google.com/apis/credentials
 *      and create an OAuth 2.0 Client ID (type: Web application).
 *   3. Under "Authorised redirect URIs" add: http://localhost:4242/callback
 *   4. Copy the Client ID and Client Secret into .env.local as
 *      YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET.
 *
 * Usage:
 *   node scripts/youtube-auth.mjs
 *
 * A browser tab will open automatically. Sign in with the YouTube channel
 * account and grant access — the token is captured automatically.
 *
 * Add to Vercel and .env.local:
 *   YOUTUBE_CLIENT_ID=...
 *   YOUTUBE_CLIENT_SECRET=...
 *   YOUTUBE_REFRESH_TOKEN=...
 */

import { readFileSync } from "fs";
import { createServer }  from "http";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

// ── Load .env.local ───────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath   = resolve(__dirname, "../.env.local");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env.local not found — rely on env vars being set another way
}

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT          = 4242;
const REDIRECT_URI  = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Error: Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env.local first.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt:      "consent", // forces refresh_token even if previously authorised
  scope: [
    "https://www.googleapis.com/auth/youtube.upload",    // upload videos
    "https://www.googleapis.com/auth/youtube",            // manage videos (required for deletion)
    "https://www.googleapis.com/auth/youtube.force-ssl",  // captions upload + post comments (Phase 2 SEO)
  ],
});

console.log("\n─────────────────────────────────────────────────────────");
console.log("Starting local callback server on http://localhost:" + PORT);
console.log("\nOpening browser for Google sign-in…");
console.log("If the browser doesn't open, copy this URL manually:\n");
console.log(authUrl);
console.log("─────────────────────────────────────────────────────────\n");

// Open the URL in the default browser
const { exec } = await import("child_process");
exec(`open "${authUrl}"`); // macOS — use 'start' on Windows, 'xdg-open' on Linux

// ── Local HTTP server to capture the redirect ─────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`);
    console.error("\nAuthorisation denied:", error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h2>No code received.</h2><p>You can close this tab.</p>");
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <h2>✅ Success!</h2>
      <p>Your refresh token has been printed in the terminal. You can close this tab.</p>
    `);

    console.log("\n─────────────────────────────────────────────────────────");
    console.log("SUCCESS — add these to Vercel and .env.local:\n");
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\n(YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are already set)");
    console.log("─────────────────────────────────────────────────────────\n");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
    console.error("\nFailed to exchange code for tokens:", err.message);
  }

  server.close();
});

server.listen(PORT, () => {
  // Server is running — waiting for redirect
});
