'use client';

import { createContext, use, useMemo, useState, type ReactNode } from 'react';

/** Demo subaccounts: the book from the fixtures and the market maker that quotes RFQ. */
export const DEMO_ACCOUNTS = [
  { id: 7, label: 'Demo book' },
  { id: 1, label: 'Demo maker' },
  { id: 12, label: 'Demo short book' },
] as const;

interface AccountContextValue {
  id: number;
  setId: (id: number) => void;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children, initial = DEMO_ACCOUNTS[0].id }: { children: ReactNode; initial?: number }) {
  const [id, setId] = useState(initial);
  const value = useMemo(() => ({ id, setId }), [id]);
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
