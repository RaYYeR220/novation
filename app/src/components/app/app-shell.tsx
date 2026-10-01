'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Lamp } from '@/components/ui/lamp';
import { meterState } from '@/components/ui/meter';
import { useAsOf, useIsDemo, useSubaccount } from '@/lib/client/hooks';
import { cn } from '@/lib/cn';
import { fmtExpiryLong, fmtNumber, fmtPct } from '@/lib/format';
import { accountLabel, useAccountId } from './account-context';
import { AccountSwitcher } from './account-switcher';
import { Nav, useSection } from './nav';
import { NetworkGuard } from './network-guard';
import { SessionChips } from './session-chips';
import { WalletButton } from './wallet-button';

function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn('inline-flex items-center gap-s2 rounded-control text-navy-50', className)}>
      <span
        aria-hidden="true"
        className="relative inline-block size-3.5 rounded-full border-2 border-current after:absolute after:inset-[3px] after:rounded-full after:bg-current"
      />
      <span className="font-display text-[21px] leading-none font-bold tracking-[-0.02em]">Novation</span>
    </Link>
  );
}

function DemoBanner() {
  const { data: asOf } = useAsOf();
  return (
    <div
      role="note"
      className="flex min-h-8 flex-wrap items-center gap-x-s4 gap-y-0.5 border-b border-navy-700 bg-navy-950 px-s4 py-1.5 text-t12 text-navy-200 sm:px-s5"
    >
      <span className="flex items-center gap-s2 text-navy-50">
        <Lamp tone="navy-200" state="ring" size={6} />
        Demo data: computed with the Novation kernel reference.
      </span>
      {asOf !== undefined && <span className="tabular-nums">Snapshot {fmtExpiryLong(asOf)}. Nothing is sent to a chain.</span>}
    </div>
  );
}

/** The selected account's margin in one line, kept in view on every page. */
function RailAccount() {
  const { id } = useAccountId();
  const { data } = useSubaccount(id);
  if (!data) return null;
  const s = data.state;
  const zone = meterState(s.equity, s.im, s.mm);
  const used = s.equity > 0 ? s.im / s.equity : 1;
  return (
    <div className="grid gap-s2 rounded-control border border-navy-700 p-s3">
      <p className="flex items-baseline justify-between text-t12 text-navy-200">
        <span>
          #{id} {accountLabel(id)}
        </span>
        <span className="tabular-nums">{fmtPct(used)} used</span>
      </p>
      <div aria-hidden="true" className="relative h-1 rounded-full bg-navy-800">
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', zone === 'clear' ? 'bg-zero' : zone === 'restricted' ? 'bg-loss-1' : 'bg-loss-3')}
          style={{ width: `${Math.min(100, used * 100)}%` }}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-s2 text-t12">
        <dt className="text-navy-200">Equity</dt>
        <dd className="text-right tabular-nums text-navy-50">{fmtNumber(s.equity)}</dd>
        <dt className="text-navy-200">Initial margin</dt>
        <dd className="text-right tabular-nums text-navy-50">{fmtNumber(s.im)}</dd>
      </dl>
    </div>
  );
}

/**
 * Rail on the left from 1280px, top bar with wallet, network, account and sessions. Below 1280 the
 * sections move to a row under the top bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const demo = useIsDemo();
  const section = useSection();
  return (
    <div className="min-h-dvh bg-navy-900 [--topbar:106px] xl:[--topbar:57px]">
      <a
        href="#main"
        className="sr-only z-[60] rounded-control bg-navy-50 px-s4 py-s2 font-medium text-navy-950 focus:not-sr-only focus:fixed focus:left-s4 focus:top-s4"
      >
        Skip to content
      </a>
      {demo && <DemoBanner />}
      <div className="xl:grid xl:grid-cols-[208px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh flex-col gap-s6 border-r border-navy-700 px-s4 py-s5 xl:flex">
          <Wordmark className="px-s2" />
          <Nav orientation="vertical" />
          <div className="mt-auto grid gap-s4">
            <RailAccount />
            <p className="px-s1 text-t12 text-navy-200">Stock tokens are not available to US persons.</p>
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-30 border-b border-navy-700 bg-navy-900/95 backdrop-blur-sm">
            <div className="flex h-14 items-center gap-s3 px-s4 sm:px-s5 xl:px-s6">
              <Wordmark className="xl:hidden" />
              <h1 className="sr-only font-display text-[26px] leading-none font-normal text-navy-50 xl:not-sr-only">
                {section?.label ?? 'App'}
              </h1>
              <div className="ml-s3 hidden xl:max-[1399px]:block">
                <SessionChips compact />
              </div>
              <div className="ml-s3 hidden min-[1400px]:block">
                <SessionChips />
              </div>
              <div className="ml-auto flex items-center gap-s2">
                <div className="hidden md:block">
                  <NetworkGuard />
                </div>
                <div className="md:hidden">
                  <NetworkGuard compact />
                </div>
                <div className="hidden sm:block">
                  <AccountSwitcher />
                </div>
                <div className="sm:hidden">
                  <AccountSwitcher compact />
                </div>
                <WalletButton />
              </div>
            </div>
            <div className="border-t border-navy-800 py-1.5 xl:hidden">
              <Nav orientation="horizontal" />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="outline-none">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
