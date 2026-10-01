'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { WagmiProvider, useWalletClient } from 'wagmi';
import { ToastProvider } from '@/components/ui/toast';
import { ClientProvider, useChainClient } from '@/lib/client/context';
import { useDataSource } from '@/lib/client/source';
import { makeWagmiConfig } from '@/lib/wallet/config';
import { AccountProvider, LiveAccountProvider } from './account-context';

const makeQueryClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } });

/** Hands the connected wallet to the chain client, which signs live-mode transactions with it. */
function WalletBridge() {
  const chain = useChainClient();
  const { data: wallet } = useWalletClient();
  useEffect(() => {
    chain?.setWallet(wallet ?? undefined);
  }, [chain, wallet]);
  return null;
}

/**
 * Data client, wallet, query cache, toasts and the selected subaccount, for the /app routes only.
 * Each data source keeps its own query cache and account selection, so switching never shows one
 * source's numbers under the other's banner.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [config] = useState(makeWagmiConfig);
  const [source] = useDataSource();
  const [caches] = useState(() => ({ demo: makeQueryClient(), live: makeQueryClient() }));
  return (
    <ClientProvider>
      <WagmiProvider config={config}>
        <QueryClientProvider client={caches[source]}>
          <WalletBridge />
          {source === 'live' ? (
            <LiveAccountProvider key="live">
              <ToastProvider>{children}</ToastProvider>
            </LiveAccountProvider>
          ) : (
            <AccountProvider key="demo">
              <ToastProvider>{children}</ToastProvider>
            </AccountProvider>
          )}
        </QueryClientProvider>
      </WagmiProvider>
    </ClientProvider>
  );
}
