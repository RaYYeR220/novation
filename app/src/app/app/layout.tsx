import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppProviders } from '@/components/app/providers';
import { AppShell } from '@/components/app/app-shell';

export const metadata: Metadata = {
  title: { template: '%s | Novation', default: 'Novation app' },
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProviders>
      <AppShell>{children}</AppShell>
    </AppProviders>
  );
}
