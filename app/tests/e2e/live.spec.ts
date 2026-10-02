import { test, expect, type Page } from '@playwright/test';
import { open } from './helpers';
import { MOCK_ACCOUNT, MOCK_AGENT, MOCK_MAKER_ID, MOCK_OWNER, injectWallet, mockChain, mockRelay } from './mock-chain';

async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: /Browser wallet|MetaMask/ }).first().click();
  await expect(page.getByRole('button', { name: /^Wallet 0x/ })).toBeVisible();
}

const DEMO_NOTE = 'Demo data: computed with the Novation kernel reference.';
const LIVE_NOTE = 'Live data: read from the Novation contracts on Robinhood Chain testnet.';

async function source(page: Page, label: 'Demo snapshot' | 'Live testnet') {
  await page.getByRole('radio', { name: label }).click({ force: true });
}

test.describe('data source switch', () => {
  test.beforeEach(async ({ page }) => {
    await mockChain(page);
  });

  test('switches to the live testnet and back, kept in the URL and in this browser', async ({ page }) => {
    await open(page, '/app/trade');
    await expect(page.getByRole('note')).toContainText(DEMO_NOTE);
    await expect(page.getByRole('radio', { name: 'Demo snapshot' })).toBeChecked();

    await source(page, 'Live testnet');
    await expect(page).toHaveURL(/[?&]data=live/);
    await expect(page.getByRole('note')).toContainText(LIVE_NOTE);
    await expect(page.getByRole('note')).not.toContainText('Demo data');

    // a reload keeps it; so does moving between sections
    await page.reload();
    await expect(page.getByRole('note')).toContainText(LIVE_NOTE);
    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name: 'Earn' }).click();
    await expect(page).toHaveURL(/\/app\/earn\?data=live/);
    await expect(page.getByRole('note')).toContainText(LIVE_NOTE);

    // this browser remembers it even without the parameter
    await page.goto('/app/risk');
    await expect(page.getByRole('note')).toContainText(LIVE_NOTE);
    await expect(page).toHaveURL(/data=live/);

    await source(page, 'Demo snapshot');
    await expect(page.getByRole('note')).toContainText(DEMO_NOTE);
    await expect(page).not.toHaveURL(/data=/);
    await page.reload();
    await expect(page.getByRole('note')).toContainText(DEMO_NOTE);
  });

  test('a ?data=demo link wins over the remembered choice', async ({ page }) => {
    await open(page, '/app/trade?data=live');
    await expect(page.getByRole('note')).toContainText(LIVE_NOTE);
    await page.goto('/app/trade?data=demo');
    await expect(page.getByRole('note')).toContainText(DEMO_NOTE);
  });
});

test.describe('live mode on a mocked RPC', () => {
  test.beforeEach(async ({ page }) => {
    await mockChain(page);
  });

  test('trade reads the chain, the vault ask and the margin what-if', async ({ page }) => {
    await open(page, `/app/trade?data=live&account=${MOCK_ACCOUNT}`);
    await expect(page.getByRole('note')).toContainText(LIVE_NOTE);
    await expect(page.getByRole('tab', { name: /NVDA/ })).toContainText('230.00');
    // the covered-call vault sells the 245 call; nobody quotes the in-the-money side
    const ask = page.getByRole('button', { name: 'Buy NVDA 245 call at ask 2.50' });
    await expect(ask).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sell NVDA 245 call: no bid quoted' })).toHaveText('—');
    await expect(page.getByRole('button', { name: 'Buy NVDA 220 put: no ask quoted' })).toBeVisible();

    await ask.click();
    const ticket = page.locator('dl').filter({ hasText: 'You pay' });
    await expect(ticket).toContainText('2.50');
    await expect(ticket).toContainText('0.07');
    await expect(page.getByRole('table', { name: /Margin now and after/ })).toContainText('2,000.93');
    await expect(page.getByRole('button', { name: /^Buy 1 NVDA/ })).toBeEnabled();
    await expect(page.getByText('Your wallet signs; the Clearinghouse re-runs the same margin check on chain.')).toBeVisible();
  });

  test("an RFQ ticket prices the relay's signed quote itself and checks it on chain", async ({ page }) => {
    // the relay claims a premium of 0.01; the signed price says 1.75, and that is what the venue charges
    await mockRelay(page, 1.75, { claimedPremium: '10000000000000000' });
    await open(page, `/app/trade?data=live&account=${MOCK_ACCOUNT}`);
    // nobody quotes the 220 put on the vault side, so the ticket goes to RFQ
    await page.getByRole('button', { name: 'Buy NVDA 220 put: no ask quoted' }).click();
    await expect(page.getByText(`Signed quote from maker account ${MOCK_MAKER_ID}`, { exact: false })).toBeVisible();
    const ticket = page.locator('dl').filter({ hasText: 'You pay' });
    await expect(ticket).toContainText('1.75');
    await expect(ticket).not.toContainText('0.01');
    await expect(page.getByRole('button', { name: /^Buy 1 NVDA/ })).toBeEnabled();
  });

  test('an RFQ price far from the kernel mark is refused before signing', async ({ page }) => {
    await mockRelay(page, 990);
    await open(page, `/app/trade?data=live&account=${MOCK_ACCOUNT}`);
    await page.getByRole('button', { name: 'Buy NVDA 220 put: no ask quoted' }).click();
    const card = page.locator('[data-code="QuoteOffMarket"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('990.00');
    await expect(card).toContainText('kernel mark of 2.00');
    await expect(page.getByRole('button', { name: /^Buy 1 NVDA/ })).toBeDisabled();
  });

  test('earn: in-kind exits show both parts, a rolled exit claims both, and a vault waits for settlement', async ({ page }) => {
    await injectWallet(page, MOCK_OWNER);
    await open(page, '/app/earn?data=live');
    await connect(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' })).toBeVisible();
    // a rolled redemption is ready in both parts: one Claim sends claimRedeemed and claimRedeemedCash
    const claim = page.locator('[data-state="claimable"]');
    await expect(claim).toContainText('0.5 NVDA + 3.00 USDG');
    await expect(claim.getByRole('button', { name: 'Claim' })).toBeEnabled();

    // an exit worth 2 NVDA: 97% in NVDA, 3% in USDG, from the vault's previewRedeemInKind
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const w = page.getByRole('dialog', { name: 'Withdraw from nccNVDA' });
    await w.getByLabel('Amount').fill('2');
    await expect(w.locator('[data-exit-preview]')).toContainText('1.94 NVDA + 13.80 USDG');
    // redeemInKind is sent with a floor under each part
    await expect(w).toContainText('floor 1% under each part');
    await expect(w).toContainText('1.9206 NVDA + 13.66 USDG');
    await expect(w.getByRole('button', { name: 'Withdraw' })).toBeEnabled();
    await w.getByRole('button', { name: 'Cancel' }).click();

    // the TSLA vault still holds an expired, priced series: deposits and instant exits wait for the roll
    await page.getByRole('list', { name: 'Vaults' }).getByRole('button').filter({ hasText: 'Covered call on TSLA' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Novation Covered Call TSLA' })).toBeVisible();
    const wait = page.locator('#vault-detail [data-state="settlement-wait"]').first();
    await expect(wait).toContainText('Waiting for settlement');
    await expect(wait).toContainText('Fri, Sep 25, 16:00 ET');
    await expect(wait).toContainText('anyone can send the roll now');
    await expect(page.getByRole('button', { name: 'Deposit TSLA' })).toBeDisabled();
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const t = page.getByRole('dialog', { name: 'Withdraw from nccTSLA' });
    await expect(t.locator('[data-state="settlement-wait"]')).toContainText('Waiting for settlement');
  });

  test("another wallet's account is view only", async ({ page }) => {
    await injectWallet(page, '0x000000000000000000000000000000000000bEEF');
    await open(page, `/app/portfolio?data=live&account=${MOCK_ACCOUNT}`);
    await connect(page);
    await expect(page.getByText('View only: not your account')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deposit', exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name: 'Trade' }).click();
    await page.getByRole('button', { name: 'Buy NVDA 245 call at ask 2.50' }).click();
    await expect(page.getByText(`View only: this wallet neither owns account ${MOCK_ACCOUNT}`, { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Buy 1 NVDA/ })).toBeDisabled();
  });

  test('an agent of the account may not fund it or manage its grants', async ({ page }) => {
    // any owner can name any wallet its agent; that must never open a deposit into its account
    await injectWallet(page, MOCK_AGENT);
    await open(page, `/app/portfolio?data=live&account=${MOCK_ACCOUNT}`);
    await connect(page);
    await expect(page.getByText('Agent of this account: only its owner can deposit or withdraw')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deposit', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Withdraw', exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name: 'Agents' }).click();
    await expect(page.getByRole('button', { name: 'Grant an agent' })).toBeDisabled();
  });

  test("the owner's wallet may deposit and withdraw", async ({ page }) => {
    await injectWallet(page, MOCK_OWNER);
    await open(page, `/app/portfolio?data=live&account=${MOCK_ACCOUNT}`);
    await connect(page);
    await expect(page.getByRole('button', { name: 'Deposit', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Withdraw', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Subaccount/ }).first()).toHaveAccessibleName(/Your account/);
  });

  test('portfolio, earn, risk and agents render chain data, with honest empty states', async ({ page }) => {
    await open(page, `/app/portfolio?data=live&account=${MOCK_ACCOUNT}`);
    await expect(page.getByRole('heading', { name: /USDG equity/ })).toContainText('2,001.50');
    await expect(page.getByRole('table', { name: `Account ${MOCK_ACCOUNT} positions` })).toContainText('NVDA 245 call');
    // no wallet: the account is shown, but nothing can be sent to it from here
    await expect(page.getByText('View only: connect the owner wallet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deposit', exact: true })).toHaveCount(0);

    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name: 'Earn' }).click();
    const vaults = page.getByRole('list', { name: 'Vaults' });
    await expect(vaults.getByRole('listitem')).toHaveCount(3);
    await expect(vaults).toContainText('23,000');
    await expect(vaults).toContainText('needs 7 days of NAV');
    await expect(page.getByText('No NAV history yet.', { exact: false })).toBeVisible();
    await expect(page.getByText('Demo replay', { exact: false })).toHaveCount(0);

    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name: 'Risk' }).click();
    const aapl = page.locator('li[data-symbol="AAPL"]');
    await expect(aapl).toContainText('Halted');
    await expect(aapl).toContainText('No halt history');
    await expect(page.getByText('Halts in the replay', { exact: false })).toHaveCount(0);
    await expect(page.getByText('100,000.00')).toBeVisible();

    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name: 'Agents' }).click();
    await expect(page.getByText(`No agent can trade for account ${MOCK_ACCOUNT}`, { exact: false })).toBeVisible();
    await expect(page.getByLabel('MCP client config')).toContainText('rpc.testnet.chain.robinhood.com');
  });

  test('without a wallet or an account, it says how to get one', async ({ page }) => {
    await open(page, '/app/portfolio?data=live');
    await expect(page.getByRole('heading', { name: 'No subaccount on RH Chain testnet yet' })).toBeVisible();
    await page.getByRole('button', { name: /^Subaccount/ }).first().click();
    await expect(page.getByRole('button', { name: 'Create a subaccount' })).toBeDisabled();
    await page.getByLabel('View account number').fill(String(MOCK_ACCOUNT));
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.getByRole('heading', { name: /USDG equity/ })).toContainText('2,001.50');
  });
});
