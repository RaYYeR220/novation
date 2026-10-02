import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { AccountProvider } from '@/components/app/account-context';
import { EarnView } from '@/components/earn/earn-view';
import { ToastProvider } from '@/components/ui/toast';
import { ClientProvider } from '@/lib/client/context';
import { MockClient, type MockOptions } from '@/lib/client/mock';
import { makeWagmiConfig } from '@/lib/wallet/config';

/** Sat Oct 3 2026, 12:00 ET. */
const SATURDAY = Date.parse('2026-10-03T16:00:00Z') / 1000;
/** Thanksgiving, Thu Nov 26 2026, 12:00 ET. */
const THANKSGIVING = Date.parse('2026-11-26T17:00:00Z') / 1000;

/** The demo snapshot in another session, read at `now`. */
class SessionMock extends MockClient {
  constructor(
    opts: MockOptions,
    private readonly now: number,
  ) {
    super(opts);
  }
  override async asOf() {
    return this.now;
  }
}

function renderEarn(client: MockClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ClientProvider client={client}>
      <WagmiProvider config={makeWagmiConfig()}>
        <QueryClientProvider client={qc}>
          <AccountProvider>
            <ToastProvider>
              <EarnView />
            </ToastProvider>
          </AccountProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ClientProvider>,
  );
}

/** Under a loaded test run the first render can take longer than testing-library's 1 s default. */
const WAIT = { timeout: 8_000 };

const rowOf = (name: RegExp) => within(screen.getByRole('list', { name: 'Vaults' })).getByRole('button', { name });

describe('earn: a vault closed for the weekend or a holiday', { timeout: 20_000 }, () => {
  it('says the NVDA vaults are closed for the weekend and when they reopen; only a redemption request goes through', async () => {
    const user = userEvent.setup();
    renderEarn(new SessionMock({ sessions: { NVDA: 'WEEKEND' } }, SATURDAY));
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);

    const nvda = rowOf(/Covered call on NVDA/);
    expect(nvda).toHaveTextContent('Closed');
    expect(nvda).toHaveTextContent('for the weekend');
    expect(nvda).not.toHaveTextContent('Not live');
    expect(rowOf(/Covered call on TSLA/)).toHaveTextContent('Live');

    const banner = document.querySelector('#vault-detail p[data-state="vault-closed"]');
    expect(banner).toHaveTextContent(
      'Closed for the weekend. No quotes, sales, buy-backs, deposits, exits or roll payouts until Sun, Oct 4, 20:00 ET. A redemption request still queues.',
    );
    expect(screen.getByRole('button', { name: 'Deposit NVDA' })).toBeDisabled();
    expect(screen.getByText(/Fails:/, { selector: 'span' }).parentElement).toHaveTextContent('Market open: NVDA is not in a weekend or holiday session');

    // instant withdrawals wait for the reopen; a redemption request still queues
    await waitFor(() => expect(screen.getByText(/you can queue a redemption now/)).toBeInTheDocument(), WAIT);
    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    const dialog = screen.getByRole('dialog', { name: 'Withdraw from nccNVDA' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Closed for the weekend');
    expect(within(dialog).getByText('The vault is closed for the weekend: no instant withdrawals until Sun, Oct 4, 20:00 ET. A redemption request still queues.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Withdraw' })).toBeDisabled();
    await user.click(within(dialog).getByText('Request redemption', { exact: true }));
    expect(within(dialog).getByRole('button', { name: 'Request redemption' })).toBeEnabled();
    expect(within(dialog).queryByText(/no instant withdrawals/)).toBeNull();
  });

  it('says a vault is closed for the holiday on a HOLIDAY session', async () => {
    const user = userEvent.setup();
    renderEarn(new SessionMock({ sessions: { TSLA: 'HOLIDAY' } }, THANKSGIVING));
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);
    expect(rowOf(/Covered call on NVDA/)).toHaveTextContent('Live');
    const tsla = rowOf(/Covered call on TSLA/);
    expect(tsla).toHaveTextContent('Closed');
    expect(tsla).toHaveTextContent('for the holiday');

    await user.click(tsla);
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call TSLA' }, WAIT);
    await waitFor(() =>
      expect(document.querySelector('#vault-detail p[data-state="vault-closed"]')).toHaveTextContent(
        'Closed for the holiday. No quotes, sales, buy-backs, deposits, exits or roll payouts until Thu, Nov 26, 20:00 ET.',
      ),
      WAIT,
    );
    expect(screen.getByRole('button', { name: 'Deposit TSLA' })).toBeDisabled();
  });

  it('keeps the regular snapshot live', async () => {
    renderEarn(new MockClient());
    await screen.findByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' }, WAIT);
    expect(document.querySelector('[data-state="vault-closed"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Deposit NVDA' })).toBeEnabled();
  });
});
