'use client';

import { useAccount, useSwitchChain } from 'wagmi';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Tooltip } from '@/components/ui/tooltip';
import { useChainClient } from '@/lib/client/context';
import { robinhoodChainTestnet, targetChain as appChain } from '@/lib/wallet/chains';

/** Live mode trades on the testnet deployment; the demo keeps the app's configured chain. */
export function useTargetChain() {
  return useChainClient() ? robinhoodChainTestnet : appChain;
}

export type NetworkStatus = 'disconnected' | 'ok' | 'wrong';

/** Where the wallet stands against the chain the app trades on. */
export function useNetworkStatus() {
  const targetChain = useTargetChain();
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const status: NetworkStatus = !isConnected ? 'disconnected' : chainId === targetChain.id ? 'ok' : 'wrong';
  return {
    status,
    chainId,
    switching: isPending,
    switchToTarget: () => switchChain({ chainId: targetChain.id }),
    target: targetChain,
  };
}

/**
 * The network the app trades on, and a switch when the wallet sits somewhere else. Signing is only
 * offered on the target chain; everything readable stays readable.
 */
export function NetworkGuard({ compact = false }: { compact?: boolean }) {
  const { status, switching, switchToTarget, target: targetChain } = useNetworkStatus();
  const name = targetChain.testnet ? 'RH Chain testnet' : 'Robinhood Chain';

  if (status === 'wrong') {
    return (
      <div className="flex items-center gap-s2">
        <Chip size="sm" lamp="loss-2">
          Wrong network
        </Chip>
        <Button size="sm" variant="secondary" loading={switching} loadingLabel="Switching" onClick={switchToTarget}>
          Switch to {name}
        </Button>
      </div>
    );
  }
  if (compact) return null;
  return (
    <Tooltip
      side="bottom"
      align="end"
      content={
        status === 'ok'
          ? `Wallet on ${targetChain.name} (chain ${targetChain.id}).`
          : `Trades settle on ${targetChain.name} (chain ${targetChain.id}). Connect a wallet to sign.`
      }
    >
      <button type="button" className="rounded-control" aria-label={`Network: ${targetChain.name}`}>
        <Chip size="sm" lamp={status === 'ok' ? 'navy-200' : 'navy-400'} lampState={status === 'ok' ? 'lit' : 'ring'}>
          {name}
        </Chip>
      </button>
    </Tooltip>
  );
}
