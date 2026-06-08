/**
 * lib/sceneImageS3.ts
 *
 * Uploads video scene images to the Remotion S3 bucket (same AWS region
 * as the Lambda renderer) instead of WordPress/SiteGround.
 *
 * Lambda fetches images from the same AWS region in ~10ms vs 200–500ms
 * from SiteGround (which may also block Lambda's IP ranges entirely).
 * This is the primary fix for the 300s render timeout.
 *
 * Images are stored with a 4-hour presigned URL so they're accessible
 * during the render without requiring public bucket access.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl }               from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand }           from "@aws-sdk/client-s3";

const REGION = process.env.REMOTION_AWS_REGION ?? "us-east-1";

function getBucketName(): string {
  // Extract bucket name from REMOTION_SERVE_URL
  // e.g. https://remotionlambda-useast1-abc123.s3.us-east-1.amazonaws.com/sites/...
  // → remotionlambda-useast1-abc123
  const serveUrl = process.env.REMOTION_SERVE_URL ?? "";
  const match    = serveUrl.match(/https?:\/\/([^.]+)\.s3\./);
  if (match) return match[1];

  // Fallback: explicit env var
  const explicit = process.env.REMOTION_S3_BUCKET ?? "";
  if (explicit) return explicit;

  throw new Error(
    "Cannot determine Remotion S3 bucket. Set REMOTION_SERVE_URL or REMOTION_S3_BUCKET."
  );
}

function getS3Client(): S3Client {
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId:     process.env.REMOTION_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY!,
    },
  });
}

/**
 * Uploads a buffer to the Remotion S3 bucket and returns a presigned URL
 * valid for 4 hours — long enough for any render to complete.
 */
export async function uploadAssetToS3(
  buffer: Buffer,
  filename: string,
  contentType: string,
  folder = "assets"
): Promise<string> {
  const bucket = getBucketName();
  const key    = `${folder}/${filename}`;
  const client = getS3Client();

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key:    key,
    Body:   buffer,
    ContentType: contentType,
  }));

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 14_400 }
  );
}

/** Convenience wrapper for PNG scene images. */
export async function uploadSceneImageToS3(
  buffer: Buffer,
  filename: string
): Promise<string> {
  return uploadAssetToS3(buffer, filename, "image/png", "scene-images");
}
