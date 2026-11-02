import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { DESCRIPTION, TAGLINE } from "@/lib/site";
import "./globals.css";

// Absolute Open Graph links; NEXT_PUBLIC_SITE_URL overrides for another host.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://deltadeck.dev";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
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
      <body className="min-h-screen">
        {children}
        {/* Vercel Web Analytics: cookie-less page views for this site only (the app sends nothing) */}
        <Analytics />
      </body>
    </html>
  );
}
