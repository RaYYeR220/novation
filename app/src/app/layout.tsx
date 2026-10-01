import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import '@/styles/globals.css';

const zodiak = localFont({
  src: [
    { path: '../../public/fonts/Zodiak-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../../public/fonts/Zodiak-Bold.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  fallback: ['Georgia', 'serif'],
  variable: '--font-zodiak',
});

const switzer = localFont({
  src: [
    { path: '../../public/fonts/Switzer-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../../public/fonts/Switzer-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../../public/fonts/Switzer-Semibold.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
  variable: '--font-switzer',
});

const TITLE = 'Novation: options clearing for Robinhood Chain stock tokens';
const DESCRIPTION =
  'The other side of every trade, stress-tested first. Novation clears options on Robinhood Chain stock tokens, re-pricing both books across 39 scenarios on-chain before a trade settles in USDG.';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: { default: TITLE, template: '%s | Novation' },
  description: DESCRIPTION,
  applicationName: 'Novation',
  icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }] },
  openGraph: {
    type: 'website',
    siteName: 'Novation',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'The Novation scenario crown beside the line: the other side of every trade, stress-tested first.' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: ['/og.png'], creator: '@rayyer_220' },
};

export const viewport: Viewport = {
  themeColor: '#05163d',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${zodiak.variable} ${switzer.variable}`}>
      <body>{children}</body>
    </html>
  );
}
