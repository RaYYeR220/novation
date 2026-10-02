import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PublicClient } from 'viem';
import { WagmiProvider } from 'wagmi';
import { AccountProvider } from '@/components/app/account-context';
import { EarnView } from '@/components/earn/earn-view';
import { Ticket, type TicketProps } from '@/components/trade/ticket';
import { ToastProvider } from '@/components/ui/toast';
import { ChainClient } from '@/lib/client/chain';
import { ClientProvider } from '@/lib/client/context';
import { MockClient } from '@/lib/client/mock';
import type { AccountState, NovationClient, Quote, Vault } from '@/lib/client/types';
import { volSyncedText } from '@/lib/market-state';
import { makeWagmiConfig } from '@/lib/wallet/config';

/** What the live transaction hook was asked to send, and what it answers. */
const h = vi.hoisted(() => ({
  labels: [] as string[],
  syncVol: vi.fn(async (_symbol: string) => undefined),
  fillRfq: vi.fn(async (_id: number, _hash: string) => '0x'),
  result: { ok: true, value: undefined } as unknown,
}));

vi.mock('@/components/app/live-tx', () => ({
  useLiveTx: () => ({
    run: async (label: string, f: (c: unknown) => Promise<unknown>) => {
      h.labels.push(label);
      await f({ syncVol: h.syncVol, fillRfq: h.fillRfq });
      return h.result;
    },
    busy: false,
    live: true,
    connected: true,
  }),
  useCanAct: () => ({ live: true, connected: true, canAct: true, checking: false }),
}));
vi.mock('@/components/app/network-guard', () => ({
  useNetworkStatus: () => ({ status: 'ok', switchToTarget: () => {} }),
}));

beforeEach(() => {
  h.labels.length = 0;
  h.syncVol.mockClear();
  h.fillRfq.mockClear();
  h.result = { ok: true, value: undefined };
});

const WAIT = { timeout: 8_000 };
const demo = new MockClient();
type Patch = Partial<Pick<Vault, 'live' | 'session' | 'volBehind'>>;

/** Live mode over the demo snapshot, with the NVDA vaults patched. */
class LiveStub extends ChainClient {
  constructor(private readonly patch: Patch = {}) {
    super({ client: { chain: { id: 46630 } } as unknown as PublicClient });
  }
  private nvda<V extends Vault>(v: V): V {
    return v.underlying === 'NVDA' ? { ...v, ...this.patch } : v;
  }
  override async asOf() {
    return demo.asOf();
  }
  override async vaults() {
    return (await demo.vaults()).map((v) => this.nvda(v));
  }
  override async vault(address: string) {
    return this.nvda(await demo.vault(address));
  }
  override async underlyings() {
    return demo.underlyings();
  }
  override async feeds() {
    return demo.feeds();
  }
  override async account(id: number) {
    return demo.account(id);
  }
}

/** The demo client with the NVDA vaults patched the same way: the demo never offers a sync. */
class DemoStub extends MockClient {
  constructor(private readonly patch: Patch) {
    super();
  }
  override async vaults() {
    return (await super.vaults()).map((v) => (v.underlying === 'NVDA' ? { ...v, ...this.patch } : v));
  }
  override async vault(address: string) {
    const v = await super.vault(address);
    return v.underlying === 'NVDA' ? { ...v, ...this.patch } : v;
  }
}

function withProviders(client: NovationClient, children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ClientProvider client={client}>
      <WagmiProvider config={makeWagmiConfig()}>
        <QueryClientProvider client={qc}>
          <AccountProvider>
            <ToastProvider>{children}</ToastProvider>
          </AccountProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ClientProvider>,
  );
}

const SYNC = { name: 'Sync NVDA vol' };

describe('earn: a vault waiting for its vol offers a sync', { timeout: 20_000 }, () => {
  it('more than one sync behind, in an open market: the action syncs the vol of the underlying', async () => {
    const user = userEvent.setup();
    withProviders(new LiveStub({ live: false, session: 'REGULAR', volBehind: 120 }), <EarnView />);
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);
    const row = within(screen.getByRole('list', { name: 'Vaults' })).getByRole('button', { name: /Covered call on NVDA/ });
    expect(row).toHaveTextContent('vol behind its feed');
    const note = await screen.findByText(/Not live until its vol catches up/, {}, WAIT);
    expect(note.closest('[data-state="vol-behind"]')).toHaveTextContent(
      'The NVDA vol is 120 rounds behind its feed, more than one sync folds. Anyone may sync it, up to 4 transactions',
    );
    await user.click(screen.getByRole('button', SYNC));
    expect(h.labels).toEqual(['Sync the vol of NVDA']);
    expect(h.syncVol).toHaveBeenCalledWith('NVDA');
  });

  it('after a feed migration too', async () => {
    withProviders(new LiveStub({ live: false, session: 'EXTENDED', volBehind: null }), <EarnView />);
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);
    expect(await screen.findByRole('button', SYNC, WAIT)).toBeEnabled();
    expect(screen.getByText(/waits for syncAndRebaseVol/)).toBeInTheDocument();
  });

  it.each([
    ['a weekend', { live: false, session: 'WEEKEND', volBehind: 120 }],
    ['a holiday', { live: false, session: 'HOLIDAY', volBehind: null }],
    ['a halt', { live: false, session: 'HALTED', volBehind: 120 }],
    ['a backlog the vault folds itself', { live: false, session: 'REGULAR', volBehind: 40 }],
    ['a live vault', { live: true, session: 'REGULAR', volBehind: 120 }],
  ] as const)('not for %s', async (_, patch) => {
    withProviders(new LiveStub(patch), <EarnView />);
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);
    await waitFor(() => expect(document.querySelector('#vault-detail')).not.toBeNull(), WAIT);
    expect(screen.queryByRole('button', SYNC)).toBeNull();
    expect(document.querySelector('#vault-detail [data-state="vol-behind"]')).toBeNull();
  });

  it('not in the demo', async () => {
    withProviders(new DemoStub({ live: false, session: 'REGULAR', volBehind: 120 }), <EarnView />);
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);
    expect(screen.queryByRole('button', SYNC)).toBeNull();
  });
});

const state: AccountState = { cash: 2000, mtm: 1.5, settledValue: 0, deficit: 0, equity: 2001.5, im: 1.5, mm: 1.125, worstScenario: 0, healthy: true, liquidatable: false };
const HASH = `0x${'cd'.repeat(32)}` as const;

function ticket(over: Partial<TicketProps> = {}): TicketProps {
  return {
    demo: false,
    accountId: 4,
    underlying: { address: '0x0101010101010101010101010101010101010101', symbol: 'NVDA', name: 'NVIDIA', spot: 230, session: 'REGULAR', markVol: 0.5, uiMultiplier: 1, halted: false },
    asOf: 1790872000,
    series: { id: 1, underlying: 'NVDA', expiry: 1790971200, strike: 245, isCall: true, bid: Number.NaN, ask: Number.NaN, delta: 0.25, iv: 0.5, mark: 2 },
    side: 'buy',
    qty: '1',
    venue: 'rfq',
    signer: 'owner',
    onSide: () => {},
    onQty: () => {},
    onVenue: () => {},
    onSigner: () => {},
    onType: () => {},
    onClear: () => {},
    grants: [],
    price: 1.75,
    now: state,
    args: { id: 4, seriesId: 1, qtyDelta: 1, premium: 1.75, venue: 'rfq' },
    pending: false,
    shock: 0.1,
    ...over,
  };
}

const rfqQuote = (refusal?: Quote['refusal']): Quote => ({
  premium: 1.75,
  fee: 0.07,
  after: state,
  ...(refusal ? { refusal } : {}),
  rfq: { maker: '0x00000000000000000000000000000000000000aa', makerId: 7, expiresAt: 1790872060, hash: HASH, price: 1.75 },
});

describe('ticket: a vol behind its feed', { timeout: 20_000 }, () => {
  const behind = { code: 'VolNotCurrent', message: 'behind', underlying: 'NVDA' };

  it('says a sync may take up to MAX_VOL_SYNC_STEPS transactions, and what follows it on each venue', () => {
    const vault = withProviders(new LiveStub(), <Ticket {...ticket({ venue: 'vault', quote: { ...rfqQuote(behind), rfq: undefined } })} />);
    expect(screen.getAllByText('Signing syncs the vol of NVDA first (up to 4 transactions, which anyone may send), then sends this trade.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^Buy 1 NVDA/ })).toBeEnabled();
    vault.unmount();

    withProviders(new LiveStub(), <Ticket {...ticket({ quote: rfqQuote(behind) })} />);
    expect(
      screen.getAllByText(
        'Signing syncs the vol of NVDA first (up to 4 transactions, which anyone may send), then checks the quote again at the new mark: sign the fill once it shows.',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('an RFQ fill held back by the sync asks for a check of the updated quote', async () => {
    const user = userEvent.setup();
    h.result = { ok: false, error: volSyncedText('NVDA'), volSynced: true };
    withProviders(new LiveStub(), <Ticket {...ticket({ quote: rfqQuote(behind) })} />);
    await user.click(screen.getByRole('button', { name: /^Buy 1 NVDA/ }));
    expect(h.fillRfq).toHaveBeenCalledWith(4, HASH);
    await waitFor(
      () => expect(document.querySelector('[role="status"][data-state="vol-synced"]')).toHaveTextContent('Vol of NVDA synced: check the updated quote and sign again.'),
      WAIT,
    );
  });

  it("offers a sync where the vault can't quote until its vol catches up, never in the demo", async () => {
    const user = userEvent.setup();
    const stuck = { ...(await demo.vaults())[0]!, live: false, volBehind: 120 };
    const live = withProviders(new LiveStub(), <Ticket {...ticket({ quote: rfqQuote(), syncVault: stuck })} />);
    expect(screen.getByText(/The NVDA covered-call vault can't quote until its vol catches up\. The NVDA vol is 120 rounds behind its feed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', SYNC));
    expect(h.labels).toEqual(['Sync the vol of NVDA']);
    expect(h.syncVol).toHaveBeenCalledWith('NVDA');
    live.unmount();

    withProviders(new MockClient(), <Ticket {...ticket({ demo: true, quote: rfqQuote(), syncVault: stuck })} />);
    expect(screen.queryByRole('button', SYNC)).toBeNull();
  });
});
