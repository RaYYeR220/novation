import { expect, test } from '@playwright/test';
import { axe, noSideScroll, open } from './helpers';

test('agents: hedge-bot at 596.51 / 1,500.00 with its refusal; revoke asks first', async ({ page }) => {
  await open(page, '/app/agents');
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  const bot = page.locator('li[data-agent="hedge-bot"]');
  await expect(bot).toContainText('596.51');
  await expect(bot).toContainText('/ 1,500.00 USDG');
  await expect(bot.getByRole('meter')).toHaveAttribute('aria-valuetext', /596\.51 of 1,500\.00 USDG used, 39\.8%.*Last refused ticket: 1,762\.72/);
  await expect(page.locator('li[data-agent="rebalancer"]')).toContainText('Expired');

  const card = page.locator('[data-code="AgentRiskBudgetExceeded"]');
  await expect(card).toContainText("hedge-bot's risk budget can't carry this ticket.");
  await expect(card).toContainText('1,762.72');
  await expect(card).toContainText('262.72');
  await expect(card.getByRole('link', { name: /Transaction 0x7c7c/ })).toHaveAttribute('href', /\/tx\/0x(7c){32}$/);
  await expect(page.locator('pre')).toContainText('"NOVATION_ACCOUNT_ID": "7"');

  // Revoke asks for confirmation; keeping it changes nothing.
  await bot.getByRole('button', { name: 'Revoke hedge-bot' }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke hedge-bot?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('reverts NotAuthorized');
  await expect(confirm.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  await expect(confirm).toBeHidden();
  await expect(bot).toBeVisible();
  await page.screenshot({ path: 'test-results/agents-1440.png', fullPage: true });

  await bot.getByRole('button', { name: 'Revoke hedge-bot' }).click();
  await page.getByRole('dialog', { name: 'Revoke hedge-bot?' }).getByRole('button', { name: 'Revoke hedge-bot' }).click();
  await expect(page.locator('li[data-agent="hedge-bot"]')).toHaveCount(0);
  await expect(page.getByText('hedge-bot revoked')).toBeVisible();
});

test('agents: the grant dialog checks the policy the way the contract does', async ({ page }) => {
  await open(page, '/app/agents');
  await page.getByRole('button', { name: 'Grant an agent' }).click();
  const d = page.getByRole('dialog', { name: 'Grant an agent on account 7' });
  await d.getByRole('button', { name: 'Grant agent' }).click();
  await expect(d.getByText('Name the agent, so refusals say who signed.')).toBeVisible();
  await expect(d.getByText(/Enter the agent.s address/)).toBeVisible();
  await d.getByLabel('Name').fill('roll-keeper');
  await d.getByLabel('Agent address').fill('0x4a1c000000000000000000000000000000009e2f');
  await expect(d.getByText(/That is the owner/)).toBeVisible();
  await d.getByLabel('Agent address').fill('0x' + 'c4'.repeat(20));
  await d.getByLabel('Risk budget').fill('400');
  await expect(d.getByText(/Under the account's worst case now \(596\.51\)/)).toBeVisible();
  await d.getByLabel('Risk budget').fill('1200');
  await d.getByText('30 days', { exact: true }).click();
  await d.getByRole('button', { name: 'Grant roll-keeper' }).click();
  await expect(d).toBeHidden();
  const row = page.locator('li[data-agent="roll-keeper"]');
  await expect(row).toContainText('/ 1,200.00 USDG');
  await expect(row).toContainText('Active');
});

test('risk: session board with halt reasons, backstops, pools, the auction ramp and refusals', async ({ page }) => {
  await open(page, '/app/risk');
  const nvda = page.locator('li[data-symbol="NVDA"]');
  await expect(nvda.locator('[data-session="REGULAR"]')).toBeVisible();
  await expect(nvda.locator('[data-halt="implausible"]')).toContainText('Implausible print');
  await expect(nvda.locator('[data-halt="multiplier"]')).toContainText('Corporate action');
  await expect(nvda.locator('[data-halt="multiplier"]')).toContainText('Tue, Sep 8, 20:00 ET for 25 h');
  await expect(nvda.locator('[data-halt="stale"]')).toContainText('13 reopen halts');
  await expect(nvda).toContainText('Coming: cash dividend of $0.25');

  await expect(page.getByText('25,000.00', { exact: true })).toBeVisible();
  const sep25 = page.locator('li[data-expiry="1790366400"]');
  await expect(sep25).toContainText('Ready, all claims paid');
  await expect(sep25).toContainText('198.00');
  await expect(sep25).toContainText('round 1100');
  await expect(page.locator('li[data-status="open"]')).toContainText('3,474');

  const auction = page.locator('li[data-auction="1"]');
  await expect(auction).toContainText('Account 12 is 55.32 USDG under maintenance; bidders take it at 5.67% off.');
  await expect(auction.getByRole('group', { name: /Discount ramp/ })).toBeVisible();
  await expect(auction).toContainText('A 50% lot pays 346.64');

  const feed = page.getByRole('list', { name: 'Refusals, newest first' });
  await expect(feed.getByRole('listitem')).toHaveCount(5);
  await expect(feed.locator('[data-code="InsufficientMargin"]')).toContainText('555.67');
  await expect(feed.locator('[data-code="VaultNotLive"]')).toContainText('multiplier change');
  await expect(feed.getByRole('link', { name: /Transaction/ })).toHaveCount(5);
  await page.screenshot({ path: 'test-results/risk-1440.png', fullPage: true });
});

test('risk and agents at 390px: no sideways scroll', async ({ page }) => {
  for (const route of ['/app/risk', '/app/agents']) {
    await open(page, route, 390, 844);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await noSideScroll(page);
    await page.screenshot({ path: `test-results/${route.split('/').pop()}-390.png`, fullPage: true });
  }
});

test('risk and agents pass axe, contrast included', async ({ page }) => {
  for (const route of ['/app/risk', '/app/agents']) {
    await open(page, route);
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await axe(page), route).toEqual([]);
  }
});
