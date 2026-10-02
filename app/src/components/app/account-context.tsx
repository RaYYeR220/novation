'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { useChainClient } from '@/lib/client/context';

/** Demo subaccounts: the book from the fixtures and the market maker that quotes RFQ. */
export const DEMO_ACCOUNTS = [
  { id: 7, label: 'Demo book' },
  { id: 1, label: 'Demo maker' },
  { id: 12, label: 'Demo short book' },
] as const;

interface AccountContextValue {
  /** The selected subaccount; 0 while live mode has none to show yet. */
  id: number;
  setId: (id: number) => void;
  /** The accounts the switcher offers. */
  accounts: readonly number[];
  label: (id: number) => string;
  /** Live mode: the connected wallet's own subaccounts. */
  owned: readonly number[];
}

const AccountContext = createContext<AccountContextValue | null>(null);

const DEMO_IDS = DEMO_ACCOUNTS.map((a) => a.id);

export function AccountProvider({ children, initial = DEMO_ACCOUNTS[0].id }: { children: ReactNode; initial?: number }) {
  const [id, setId] = useState(initial);
  const value = useMemo(() => ({ id, setId, accounts: DEMO_IDS, label: accountLabel, owned: [] }), [id]);
  return <AccountContext value={value}>{children}</AccountContext>;
}

function urlAccount(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = Number(new URLSearchParams(window.location.search).get('account'));
  return Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Live mode: the account picked (or ?account=N), else the connected wallet's first subaccount, else
 * the account that traded last on the deployment, so the pages have real data before a wallet connects.
 */
export function LiveAccountProvider({ children }: { children: ReactNode }) {
  const chain = useChainClient();
  const { address } = useAccount();
  const [picked, setPicked] = useState<number | undefined>(urlAccount);
  const owned = useQuery({
    queryKey: ['live', 'owned', address],
    queryFn: () => chain!.subaccountsOf(address as string),
    enabled: Boolean(chain && address),
  });
  const featured = useQuery({ queryKey: ['live', 'featured'], queryFn: () => chain!.featuredAccount(), enabled: Boolean(chain) });
  const vaults = useQuery({ queryKey: ['live', 'vault-accounts'], queryFn: () => chain!.vaultAccounts(), enabled: Boolean(chain) });
  const mine = useMemo(() => (address ? (owned.data ?? []) : []), [address, owned.data]);
  const id = picked ?? mine[0] ?? featured.data ?? 0;
  const label = useCallback(
    (x: number) => {
      if (mine.includes(x)) return 'Your account';
      const v = vaults.data?.get(x);
      if (v) return `${v} vault`;
      return 'View only';
    },
    [mine, vaults.data],
  );
  const accounts = useMemo(() => [...new Set([...mine, ...(featured.data ? [featured.data] : []), ...(id ? [id] : [])])], [mine, featured.data, id]);
  const value = useMemo(() => ({ id, setId: setPicked, accounts, label, owned: mine }), [id, accounts, label, mine]);
  return <AccountContext value={value}>{children}</AccountContext>;
}

/** The subaccount the app is acting for. */
export function useAccountId(): AccountContextValue {
  const ctx = use(AccountContext);
  if (!ctx) throw new Error('useAccountId must be inside AccountProvider');
  return ctx;
}

export function accountLabel(id: number): string {
  return DEMO_ACCOUNTS.find((a) => a.id === id)?.label ?? `Account ${id}`;
}
