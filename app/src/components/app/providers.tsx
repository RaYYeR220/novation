'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { ToastProvider } from '@/components/ui/toast';
import { makeWagmiConfig } from '@/lib/wallet/config';
import { AccountProvider } from './account-context';

/** Wallet, query cache, toasts and the selected subaccount, for the /app routes only. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [config] = useState(makeWagmiConfig);
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }),
  );
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <AccountProvider>
          <ToastProvider>{children}</ToastProvider>
        </AccountProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
