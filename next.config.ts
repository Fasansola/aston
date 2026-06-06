import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Remotion Lambda and AWS SDK use native Node.js modules that Next.js
  // cannot bundle. Mark them as external so they are required at runtime.
  serverExternalPackages: [
    "@remotion/lambda-client",
    "@remotion/lambda",
    "@aws-sdk/client-lambda",
    "@aws-sdk/client-s3",
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
};

export default nextConfig;
