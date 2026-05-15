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
 *      and create an OAuth 2.0 Client ID (type: Desktop app).
 *   3. Copy the Client ID and Client Secret into this script below,
 *      or set them as env vars YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET.
 *
 * Usage:
 *   node scripts/youtube-auth.mjs
 *
 * Then open the printed URL in a browser, sign in with the YouTube channel
 * account, grant access, paste the code back here, and the script will
 * print your refresh token.
 *
 * Add these three env vars to Vercel (and your .env.local):
 *   YOUTUBE_CLIENT_ID=...
 *   YOUTUBE_CLIENT_SECRET=...
 *   YOUTUBE_REFRESH_TOKEN=...
 */

import { createServer } from "http";
import { google } from "googleapis";
import readline from "readline";

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     || "<paste your client ID here>";
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || "<paste your client secret here>";
const REDIRECT_URI  = "urn:ietf:wg:oauth:2.0:oob"; // desktop / manual copy flow

if (CLIENT_ID.startsWith("<") || CLIENT_SECRET.startsWith("<")) {
  console.error("Error: Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // forces refresh_token to be returned even if already authorised
  scope: ["https://www.googleapis.com/auth/youtube.upload"],
});

console.log("\n─────────────────────────────────────────────────────────");
console.log("STEP 1 — Open this URL in your browser and sign in:");
console.log("\n" + authUrl + "\n");
console.log("─────────────────────────────────────────────────────────");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("STEP 2 — Paste the authorisation code here: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("SUCCESS — add these to Vercel and .env.local:\n");
    console.log(`YOUTUBE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`YOUTUBE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("─────────────────────────────────────────────────────────\n");
  } catch (err) {
    console.error("Failed to exchange code for tokens:", err.message);
    process.exit(1);
  }
});
