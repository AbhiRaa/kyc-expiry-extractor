import type { Metadata, Viewport } from 'next';
import './globals.css';

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
