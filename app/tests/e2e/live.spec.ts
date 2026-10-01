import { test, expect, type Page } from '@playwright/test';
import { open } from './helpers';
import { MOCK_ACCOUNT, MOCK_MAKER_ID, mockChain, mockRelay } from './mock-chain';

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

  test("an RFQ ticket takes the relay's signed quote and checks it on chain", async ({ page }) => {
    await mockRelay(page, 1.75);
    await open(page, `/app/trade?data=live&account=${MOCK_ACCOUNT}`);
    // nobody quotes the 220 put on the vault side, so the ticket goes to RFQ
    await page.getByRole('button', { name: 'Buy NVDA 220 put: no ask quoted' }).click();
    await expect(page.getByText(`Signed quote from maker account ${MOCK_MAKER_ID}`, { exact: false })).toBeVisible();
    const ticket = page.locator('dl').filter({ hasText: 'You pay' });
    await expect(ticket).toContainText('1.75');
    await expect(page.getByRole('button', { name: /^Buy 1 NVDA/ })).toBeEnabled();
  });

  test('portfolio, earn, risk and agents render chain data, with honest empty states', async ({ page }) => {
    await open(page, `/app/portfolio?data=live&account=${MOCK_ACCOUNT}`);
    await expect(page.getByRole('heading', { name: /USDG equity/ })).toContainText('2,001.50');
    await expect(page.getByRole('table', { name: `Account ${MOCK_ACCOUNT} positions` })).toContainText('NVDA 245 call');
    await expect(page.getByRole('button', { name: 'Deposit' })).toBeVisible();

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
