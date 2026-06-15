import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Remotion Lambda and AWS SDK use native Node.js modules that Next.js
  // cannot bundle. Mark them as external so they are required at runtime.
  serverExternalPackages: [
    "@remotion/lambda-client",
    "@remotion/lambda",
    "@aws-sdk/client-lambda",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@aws-sdk/client-iam",
    "@aws-sdk/client-cloudwatch-logs",
    "@aws-sdk/client-service-quotas",
  ],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "oaidalleapiprodscus.blob.core.windows.net",
      },
    ],
  },
  // Next's output file tracing doesn't auto-detect the ffmpeg-static binary
  // (it's referenced via a runtime path string, not a static import), so it was
  // missing from the deployed function (spawn … ENOENT). Force it into the
  // podcast route's trace so the binary ships with the function.
  outputFileTracingIncludes: {
    "/api/generate-podcast": ["./node_modules/ffmpeg-static/**/*"],
  },
};

export default withWorkflow(nextConfig);
