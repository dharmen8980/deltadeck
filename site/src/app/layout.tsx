import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { DESCRIPTION, TAGLINE } from "@/lib/site";
import "./globals.css";

// On Vercel, Next.js falls back to the production URL for absolute Open Graph links.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: `DeltaDeck: ${TAGLINE}`,
  description: DESCRIPTION,
  applicationName: "DeltaDeck",
  openGraph: {
    type: "website",
    siteName: "DeltaDeck",
    title: `DeltaDeck: ${TAGLINE}`,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `DeltaDeck: ${TAGLINE}` }],
  },
  twitter: {
    card: "summary_large_image",
    title: `DeltaDeck: ${TAGLINE}`,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="antialiased">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
