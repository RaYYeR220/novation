import { createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { robinhoodChain, robinhoodChainTestnet } from './chains';

/** WalletConnect needs a project id; without one the connector is left out and the menu does not offer it. */
export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined;

export function makeWagmiConfig() {
  return createConfig({
    chains: [robinhoodChain, robinhoodChainTestnet],
    connectors: [
      injected({ shimDisconnect: true }),
      ...(walletConnectProjectId
        ? [
            walletConnect({
              projectId: walletConnectProjectId,
              showQrModal: true,
              metadata: {
                name: 'Novation',
                description: 'Portfolio-margined options on Robinhood Chain stock tokens.',
                url: typeof window === 'undefined' ? '' : window.location.origin,
                icons: [],
              },
            }),
          ]
        : []),
    ],
    transports: {
      [robinhoodChain.id]: http(),
      [robinhoodChainTestnet.id]: http(),
    },
    // Reconnect after hydration so server and first client render agree.
    ssr: true,
  });
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof makeWagmiConfig>;
  }
}
