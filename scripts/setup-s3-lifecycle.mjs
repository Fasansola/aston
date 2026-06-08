/**
 * scripts/setup-s3-lifecycle.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Applies an S3 Lifecycle policy to the Remotion bucket so that temporary
 * assets are automatically deleted after 7 days, keeping storage costs low.
 *
 * What gets deleted after 7 days:
 *   scene-images/   — background images generated per video (only needed during render)
 *   assets/         — logo + music copies uploaded before each render
 *
 * What is NEVER touched:
 *   renders/        — final rendered .mp4 files (kept permanently)
 *   sites/          — Remotion site bundle (kept permanently)
 *
 * Also configures:
 *   AbortIncompleteMultipartUpload after 1 day — cleans up failed uploads
 *
 * Usage:
 *   node scripts/setup-s3-lifecycle.mjs            ← apply / update rules
 *   node scripts/setup-s3-lifecycle.mjs --check    ← print current rules only
 *
 * Safe to re-run — replaces existing lifecycle rules with the canonical set.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  S3Client,
  PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";

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
  console.error("Could not read .env.local — make sure you run this from the project root.");
  process.exit(1);
}

// ── Resolve bucket name ───────────────────────────────────────────────────────

function getBucketName() {
  const serveUrl = process.env.REMOTION_SERVE_URL ?? "";
  const match    = serveUrl.match(/https?:\/\/([^.]+)\.s3\./);
  if (match) return match[1];

  const explicit = process.env.REMOTION_S3_BUCKET ?? "";
  if (explicit) return explicit;

  throw new Error(
    "Cannot determine bucket name.\n" +
    "Set REMOTION_SERVE_URL or REMOTION_S3_BUCKET in .env.local"
  );
}

// ── S3 client ─────────────────────────────────────────────────────────────────

const REGION = process.env.REMOTION_AWS_REGION ?? "us-east-1";
const client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId:     process.env.REMOTION_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY,
  },
});

// ── Lifecycle rules ───────────────────────────────────────────────────────────

const LIFECYCLE_RULES = [
  {
    ID:     "expire-scene-images-7d",
    Status: "Enabled",
    Filter: { Prefix: "scene-images/" },
    Expiration: { Days: 7 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  },
  {
    ID:     "expire-assets-7d",
    Status: "Enabled",
    Filter: { Prefix: "assets/" },
    Expiration: { Days: 7 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

const checkOnly = process.argv.includes("--check");

try {
  const bucket = getBucketName();
  console.log(`\nBucket : ${bucket}`);
  console.log(`Region : ${REGION}\n`);

  // Always print current rules first
  try {
    const existing = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
    );
    console.log("Current lifecycle rules:");
    for (const rule of existing.Rules ?? []) {
      const prefix = rule.Filter?.Prefix ?? "(none)";
      const days   = rule.Expiration?.Days ?? "—";
      console.log(`  [${rule.Status}] ${rule.ID}  prefix="${prefix}"  expires=${days}d`);
    }
    console.log();
  } catch (e) {
    if (e.name === "NoSuchLifecycleConfiguration") {
      console.log("No lifecycle rules currently configured.\n");
    } else {
      throw e;
    }
  }

  if (checkOnly) {
    console.log("--check flag set — no changes made.");
    process.exit(0);
  }

  // Apply rules
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: LIFECYCLE_RULES },
    })
  );

  console.log("✓ Lifecycle policy applied:");
  for (const rule of LIFECYCLE_RULES) {
    console.log(`  [${rule.Status}] ${rule.ID}  prefix="${rule.Filter.Prefix}"  expires=${rule.Expiration.Days}d`);
  }
  console.log("\nScene images and assets will be automatically deleted after 7 days.");
  console.log("Rendered videos (renders/) and site bundles (sites/) are not affected.");

} catch (err) {
  console.error("\n✗ Failed:", err.message ?? err);
  process.exit(1);
}
