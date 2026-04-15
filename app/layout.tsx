import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blog Generator — Aston.ae",
  description: "Internal tool to generate and publish blog posts to aston.ae",
  robots: "noindex, nofollow",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
