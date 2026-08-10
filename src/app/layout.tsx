import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

/**
 * The v2 design specifies Geist for prose and Geist Mono for every machine-
 * readable value (dates, enums, reason codes, bboxes, JSON) — the typographic
 * split *is* the argument that this UI keeps the contract visible next to the
 * human string.
 *
 * The mockup loads both from `fonts.googleapis.com` with a `<link>`. Here they go
 * through `next/font/google`, which self-hosts the files as static assets and
 * emits no request to Google at page view. That is a performance win (no
 * render-blocking third-party round trip, no layout shift) and, for this app in
 * particular, a consistency one: a page whose central claim is "nothing about
 * your document leaves your browser" should not open a connection to an ad
 * network's font CDN to say so.
 */
const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

/**
 * Metadata only (§10 keeps the shell minimal).
 *
 * `viewport` is separated out because the demo is expected to be opened on a
 * phone between meetings (§10) — without `width=device-width` mobile Safari
 * renders the page at 980px and the whole thing reads as a broken desktop site.
 * `maximumScale` is deliberately left unset so pinch-zoom still works (WCAG 1.4.4).
 */
export const metadata: Metadata = {
  title: 'KYC Document Expiry Extraction',
  description:
    'Upload an identity or address document and get a validity verdict with the rule it was reached on, the evidence it was read from, and the constraints that eliminated every other candidate date.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
