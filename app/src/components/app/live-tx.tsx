'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useAccount, useConfig, useSwitchChain } from 'wagmi';
import { getWalletClient } from 'wagmi/actions';
import { useToast } from '@/components/ui/toast';
import { LIVE_CHAIN, VolSyncedError, refusalOf, type ChainClient } from '@/lib/client/chain';
import { useChainClient } from '@/lib/client/context';
import type { Refusal } from '@/lib/client/types';
import { VOL_SYNC_TXS } from '@/lib/market-state';
import { explorerTx } from '@/lib/wallet/chains';

/** `volSynced`: an RFQ fill waited for a vol sync and was not signed; the ticket checks a fresh quote. */
export type TxResult<T> = { ok: true; value: T } | { ok: false; refusal?: Refusal; error: string; volSynced?: boolean };

/** A wallet or node error in one line: viem's short message, without the request dump. */
export function shortError(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string; name?: string };
  if (x?.name === 'UserRejectedRequestError' || /rejected|denied/i.test(x?.shortMessage ?? x?.message ?? '')) return 'You rejected the request in the wallet.';
  return (x?.shortMessage ?? x?.message ?? String(e)).split('\n')[0] ?? 'Unknown error';
}

function hashOf(v: unknown): string | undefined {
  if (typeof v === 'string' && v.startsWith('0x')) return v;
  if (Array.isArray(v)) return hashOf(v.at(-1));
  const h = (v as { hash?: unknown } | undefined)?.hash;
  return typeof h === 'string' ? h : undefined;
}

/**
 * Sends live-mode transactions through the connected wallet: switches it to RH Chain testnet first,
 * shows a pending toast, links the mined transaction, and turns an on-chain refusal into its code and
 * numbers. Every query re-reads afterwards.
 */
export function useLiveTx() {
  const chain = useChainClient();
  const qc = useQueryClient();
  const { toast, dismiss } = useToast();
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const config = useConfig();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T,>(label: string, f: (c: ChainClient) => Promise<T>): Promise<TxResult<T>> => {
      if (!chain) return { ok: false, error: 'Demo mode: nothing is sent.' };
      if (!isConnected) {
        toast({ tone: 'neutral', title: 'Connect a wallet to sign', description: 'Use Connect wallet in the top bar.' });
        return { ok: false, error: 'No wallet connected.' };
      }
      setBusy(true);
      let pending: number | undefined;
      try {
        if (chainId !== LIVE_CHAIN.id) await switchChainAsync({ chainId: LIVE_CHAIN.id });
        // a wallet client for the live chain now, not the one React handed over before the switch
        chain.setWallet(await getWalletClient(config, { chainId: LIVE_CHAIN.id }));
        pending = toast({ tone: 'pending', title: label, description: 'Confirm in your wallet; then it waits for the block.' });
        // a vol behind its feed is synced first: more transactions to confirm
        chain.onVolSync((symbol) => {
          if (pending !== undefined) dismiss(pending);
          pending = toast({
            tone: 'pending',
            title: `Syncing the vol of ${symbol}`,
            description: `Its vol estimate is behind the feed. Anyone may send the sync, ${VOL_SYNC_TXS}: confirm each in your wallet.`,
          });
        });
        const value = await f(chain);
        dismiss(pending);
        const hash = hashOf(value);
        toast({
          tone: 'done',
          title: `${label}: done`,
          action: hash ? (
            <a href={explorerTx(hash, LIVE_CHAIN.id)} target="_blank" rel="noreferrer" className="underline decoration-navy-400 underline-offset-4">
              View transaction<span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : undefined,
        });
        await qc.invalidateQueries();
        return { ok: true, value };
      } catch (e) {
        if (pending !== undefined) dismiss(pending);
        if (e instanceof VolSyncedError) {
          toast({
            tone: 'neutral',
            title: e.message,
            description: e.current
              ? 'The new vol moves the kernel mark the quote was checked against, so the fill was not signed. The ticket checks a fresh quote against the new mark.'
              : 'The vol is still behind its feed after the syncs this sends at most, so the fill was not signed. Try again in a moment: the ticket checks a fresh quote first.',
          });
          await qc.invalidateQueries();
          return { ok: false, error: e.message, volSynced: true };
        }
        const refusal = refusalOf(e);
        const error = refusal ? `${refusal.code}: ${refusal.message}` : shortError(e);
        toast({ tone: 'refused', title: refusal ? `Refused on chain: ${refusal.code}` : `${label} failed`, description: refusal?.message ?? error });
        return { ok: false, refusal, error };
      } finally {
        chain.onVolSync(undefined);
        setBusy(false);
      }
    },
    [chain, isConnected, chainId, switchChainAsync, config, toast, dismiss, qc],
  );

  return { run, busy, live: Boolean(chain), connected: isConnected };
}

/**
 * Live mode: whether the connected wallet may act for account `id` (owner or live agent grant).
 * Other accounts, a featured one or one opened by number, are view only.
 */
export function useCanAct(id: number) {
  const chain = useChainClient();
  const { address } = useAccount();
  const enabled = Boolean(chain && address && id > 0);
  const q = useQuery({ queryKey: ['live', 'can-act', id, address], queryFn: () => chain!.canAct(id), enabled });
  return { live: Boolean(chain), connected: Boolean(address), canAct: q.data === true, checking: enabled && q.isPending };
}
