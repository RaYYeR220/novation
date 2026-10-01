import { expect, test } from '@playwright/test';
import { axe, noSideScroll, open, pickAccount } from './helpers';

test('portfolio: account 7, the crown and the session switch recomputing initial margin', async ({ page }) => {
  await open(page, '/app/portfolio');
  await expect(page.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeVisible();
  const hero = page.getByRole('heading', { level: 2, name: /USDG equity/ });
  await expect(hero).toContainText('10,348.17');
  await expect(page.getByText('Account #7, Demo book')).toBeVisible();

  const crown = page.getByTestId('portfolio-crown').locator('figure[data-variant="panel"]');
  await expect(crown.getByRole('table')).toContainText('Regular session. Initial margin 596.51 USDG');
  await expect(crown.getByText('596.51', { exact: true })).toBeVisible();
  const meter = page.getByRole('meter', { name: /Equity against margin/ });
  await expect(meter).toHaveAttribute('aria-valuetext', /Initial margin 596\.51/);

  // The session switch re-prices the book under weekend shocks: 596.51 -> 1,373.29.
  await crown.getByRole('button', { name: 'Weekend' }).click();
  await expect(crown.getByRole('button', { name: 'Weekend' })).toHaveAttribute('aria-pressed', 'true');
  await expect(crown.getByRole('table')).toContainText('Weekend session. Initial margin 1,373.29 USDG');
  await expect(crown.getByText('1,373.29', { exact: true })).toBeVisible();
  await expect(meter).toHaveAttribute('aria-valuetext', /Initial margin 1,373\.29/);
  const row = page.locator('tr[data-row="im-weekend"]');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('tr[data-row="weekend-adds"]')).toContainText('+776.78');

  // Positions at the kernel mark, and collateral.
  await expect(page.getByRole('table', { name: 'Account 7 positions' })).toContainText('NVDA 200 call');
  await expect(page.getByRole('table', { name: 'Account 7 positions' })).toContainText('−1,023.67');
  await expect(page.getByText('40 NVDA tokens at 225.57')).toBeVisible();

  // Expiries: the open one at today's spot, then settled, claimable and claimed with pool readiness.
  const oct2 = page.locator('li[data-status="open"]');
  await expect(oct2).toContainText('pays 1,022.80 into the pool from cash 2,400.00');
  const sep25 = page.locator('li[data-expiry="1790366400"]');
  await expect(sep25).toHaveAttribute('data-status', 'claimed');
  await expect(sep25.locator('[data-step="settle"]')).toContainText('Fri, Sep 25, 16:03 ET');
  await expect(sep25.locator('[data-step="claimable"]')).toContainText('Pool ready: 0 short contracts unsettled');
  await expect(sep25.locator('[data-step="claimed"]')).toContainText('33.73 moved into cash');
  await expect(sep25).toContainText('round 145');
  await expect(page.locator('#risk-callout')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/portfolio-1440.png', fullPage: true });
});

test('portfolio: the short book shows the liquidation callout and its cleared deficit', async ({ page }) => {
  await open(page, '/app/portfolio');
  await pickAccount(page, /Demo short book/);
  const callout = page.locator('section[data-level="liquidatable"]');
  await expect(callout).toContainText('Below maintenance margin: this account can be liquidated.');
  await expect(callout).toContainText('55.32 short of maintenance');
  await expect(callout).toContainText('5.67% off');
  const sep25 = page.locator('li[data-expiry="1790366400"]');
  await expect(sep25).toHaveAttribute('data-status', 'deficit-cleared');
  await expect(sep25.locator('[data-step="bridged"]')).toContainText('the insurance fund bridged 198.00');
  await expect(sep25.locator('[data-step="cleared"]')).toContainText('0.9405 NVDA at 210.54');
  await expect(page.locator('li[data-status="open"]')).toContainText('leaves 150.17 short');
});

test('earn: vault rows, detail, and the deposit dialog validates input', async ({ page }) => {
  await open(page, '/app/earn');
  const rows = page.getByRole('list', { name: 'Vaults' }).getByRole('button');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Covered call on NVDA');
  await expect(rows.first()).toContainText('599,230');
  await expect(rows.first()).toContainText('Live');
  await expect(page.getByRole('heading', { level: 2, name: 'Novation Covered Call NVDA' })).toBeVisible();
  await expect(page.getByText('Locked behind open shorts')).toBeVisible();
  await expect(page.getByText('1,592 NVDA')).toBeVisible();

  await page.getByRole('button', { name: 'Deposit NVDA' }).click();
  const dialog = page.getByRole('dialog', { name: 'Deposit into nccNVDA' });
  await expect(dialog).toBeVisible();
  const amount = dialog.getByLabel('Amount');
  await expect(amount).toBeFocused();
  await amount.fill('abc');
  await expect(dialog.getByText('Numbers only.')).toBeVisible();
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await amount.fill('0');
  await expect(dialog.getByText('The amount must be above zero.')).toBeVisible();
  await amount.fill('20');
  await expect(dialog.getByText('That is more than your wallet holds: 12.5 NVDA.')).toBeVisible();
  await dialog.getByRole('button', { name: /^Deposit/ }).click();
  await expect(dialog).toBeVisible();
  await amount.fill('2');
  await expect(amount).not.toHaveAttribute('aria-invalid', 'true');
  await expect(dialog).toContainText('1.9575 shares');
  await expect(dialog).toContainText('Exits openTue, Sep 29, 13:00 ET');
  await dialog.getByRole('button', { name: 'Deposit 2 NVDA' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Checked, not sent')).toBeVisible();

  // Withdraw: the shares arrived 25 minutes ago, so the exit cooldown holds them.
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  const w = page.getByRole('dialog', { name: 'Withdraw from nccNVDA' });
  await expect(w).toContainText('Exits open Tue, Sep 29, 12:35 ET, 35 min from now.');
  await expect(w.getByRole('button', { name: 'Withdraw' })).toBeDisabled();
  await w.getByRole('button', { name: 'Cancel' }).click();

  // The put-write vault: shares past the cooldown can queue a redemption for the next roll.
  await rows.nth(1).click();
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  const pw = page.getByRole('dialog', { name: 'Withdraw from npwNVDA' });
  await pw.getByText('Request redemption', { exact: true }).click();
  await pw.getByLabel('Amount').fill('500');
  await expect(pw).toContainText('paid by the roll after the Fri, Oct 2, 16:00 ET expiry settles');
  await pw.getByRole('button', { name: 'Request redemption' }).click();
  await expect(page.getByText(/shares queued for the roll after Fri, Oct 2/)).toBeVisible();
});

test('earn and portfolio at 390px: no sideways scroll', async ({ page }) => {
  for (const route of ['/app/earn', '/app/portfolio']) {
    await open(page, route, 390, 844);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await noSideScroll(page);
    await page.screenshot({ path: `test-results/${route.split('/').pop()}-390.png`, fullPage: true });
  }
});

test('earn and portfolio pass axe, contrast included', async ({ page }) => {
  for (const route of ['/app/earn', '/app/portfolio']) {
    await open(page, route);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await axe(page), route).toEqual([]);
  }
});
