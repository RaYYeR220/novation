import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { ClientProvider } from '@/lib/client/context';
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

export const metadata: Metadata = {
  title: 'Novation',
  description: 'Portfolio margin for Robinhood Chain stock-token options, computed on-chain.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${zodiak.variable} ${switzer.variable}`}>
      <body>
        <ClientProvider>{children}</ClientProvider>
      </body>
    </html>
  );
}
