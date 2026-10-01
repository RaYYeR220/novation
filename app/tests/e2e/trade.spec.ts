import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const axePath = path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js');

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app/trade');
  await page.evaluate(() => document.fonts.ready);
}

const ticketOf = (page: Page) => page.getByRole('complementary', { name: 'Order ticket' });
const imRow = (page: Page) => ticketOf(page).getByRole('row', { name: /Initial margin/ });

test('trade: NVDA ticket shows margin before and after; the over-budget agent ticket is refused with exact numbers', async ({ page }) => {
  await open(page, 1440, 900);
  await expect(page.getByRole('heading', { level: 1, name: 'Trade' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Demo data: computed with the Novation kernel reference.');

  // Pick NVDA and open a ticket from the chain: the ask buys.
  await page.getByRole('tab', { name: /TSLA/ }).click();
  await page.getByRole('tab', { name: /NVDA/ }).click();
  await expect(page.getByRole('tab', { name: /NVDA/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /^Buy NVDA 225 call at ask/ }).click();

  const ticket = ticketOf(page);
  await expect(ticket.getByRole('heading', { name: 'NVDA 225 call' })).toBeVisible();
  // Weekly expiries are the NYSE Friday close.
  await expect(ticket.getByText(/Expires Fri, Oct 2, 16:00 ET/)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Expiry', exact: true }).getByRole('radio')).toHaveCount(4);
  await expect(page.getByRole('group', { name: 'Expiry', exact: true })).toContainText('Oct 2');
  await expect(page.getByRole('group', { name: 'Expiry', exact: true })).toContainText('Oct 23');
  // Margin before and after: the table and both lanes of the meter.
  await expect(imRow(page).getByRole('cell').nth(0)).toHaveText('596.51');
  await expect(imRow(page).getByRole('cell').nth(1)).toHaveText('600.93');
  await expect(imRow(page).getByRole('cell').nth(2)).toHaveText('+4.42');
  await expect(ticket.getByRole('meter', { name: 'Now' })).toHaveAttribute('aria-valuetext', /initial margin 596\.51/);
  await expect(ticket.getByRole('meter', { name: /^After/ })).toHaveAttribute('aria-valuetext', /initial margin 600\.93/);
  await expect(ticket.getByRole('button', { name: 'Buy 1 NVDA 225C' })).toBeEnabled();
  // This ticket is not in the kernel fixtures: every float figure says so.
  await expect(ticket.getByText('Estimate', { exact: true })).toBeVisible();
  await expect(ticket.getByText(/after −[\d,.]+ \(estimate\)/)).toBeVisible();
  await expect(ticket.getByRole('columnheader', { name: /After\s*estimate/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/trade-1440-ticket.png' });

  // Drive the over-budget ticket by hand: sell 60 of the 200 call through RFQ, signed by hedge-bot.
  await page.getByRole('button', { name: /^Sell NVDA 200 call at bid/ }).click();
  await ticket.getByLabel('Quantity').fill('60');
  await ticket.getByRole('group', { name: 'Venue' }).getByText('RFQ', { exact: true }).click();
  await ticket.getByRole('group', { name: 'Sign as' }).getByText('hedge-bot', { exact: true }).click();

  const refusal = ticket.locator('[data-code="AgentRiskBudgetExceeded"]');
  await expect(refusal).toBeVisible();
  await expect(refusal).toHaveAttribute('role', 'alert');
  await expect(refusal).toContainText(
    'Worst case after this trade: 1,762.72 USDG against a 1,500.00 USDG budget (596.51 now; this ticket adds 1,166.21)',
  );
  await expect(refusal.getByRole('definition').first()).toContainText('1,762.72');
  await expect(refusal).toContainText('262.72');
  await expect(ticket.getByRole('button', { name: 'Sell 60 NVDA 200C' })).toBeDisabled();
  // The kernel's exact after-state and grid for this ticket: nothing is labelled an estimate.
  await expect(imRow(page).getByRole('cell').nth(1)).toHaveText('1,762.72');
  await expect(ticket.getByText('Exact', { exact: true })).toBeVisible();
  await expect(ticket.getByText(/\(estimate\)/)).toHaveCount(0);
  await refusal.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/trade-1440-refused.png' });

  // What would pass: the resize clears the same check.
  // The largest size that clears every agent check: 19 contracts keeps the premium under the 500 cap.
  const cut = refusal.getByRole('button', { name: 'Cut to 19' });
  await expect(cut).toBeVisible();
  await cut.click();
  await expect(refusal).toHaveCount(0);
  await expect(ticket.getByRole('button', { name: 'Sell 19 NVDA 200C' })).toBeEnabled();

  // The owner signing the full 60 clears: the budget binds the agent, not the account.
  await ticket.getByLabel('Quantity').fill('60');
  await ticket.getByRole('group', { name: 'Sign as' }).getByText('Owner', { exact: true }).click();
  await expect(ticket.locator('[data-code]')).toHaveCount(0);
  await expect(ticket.getByRole('button', { name: 'Sell 60 NVDA 200C' })).toBeEnabled();
});

test('trade: the demo shortcut loads the refused agent ticket', async ({ page }) => {
  await open(page, 1440, 900);
  await page.getByRole('button', { name: 'Load the refused agent ticket' }).first().click();
  const refusal = ticketOf(page).locator('[data-code="AgentRiskBudgetExceeded"]');
  await expect(refusal).toContainText('1,762.72');
  await expect(refusal).toContainText('this ticket adds 1,166.21');
  await expect(ticketOf(page).getByRole('heading', { name: 'NVDA 200 call' })).toBeVisible();
});

test('trade at 390px: the ticket is a bottom sheet and the page never scrolls sideways', async ({ page }) => {
  await open(page, 390, 844);
  await page.getByRole('button', { name: /^Buy NVDA 225 call at ask/ }).click();
  const ticket = ticketOf(page);
  await expect(ticket.getByRole('heading', { name: 'NVDA 225 call' })).toBeFocused();
  await expect(imRow(page).getByRole('cell').nth(1)).toHaveText('600.93');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/trade-390-sheet.png' });

  // Escape folds the sheet to its handle, which carries the margin after.
  await page.keyboard.press('Escape');
  const handle = ticket.locator('button[aria-expanded]');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(handle).toContainText('Initial margin 596.51 to 600.93');
  await page.screenshot({ path: 'test-results/trade-390.png' });
  await handle.click();
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
});

test('/app/trade passes axe in the browser, contrast included', async ({ page }) => {
  await open(page, 1440, 900);
  await page.getByRole('button', { name: 'Load the refused agent ticket' }).first().click();
  await expect(ticketOf(page).locator('[data-code]')).toBeVisible();
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
  });
  expect(violations).toEqual([]);
});

test('/app redirects to trade and every section link resolves', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/app\/trade$/);
  for (const name of ['Earn', 'Portfolio', 'Risk', 'Agents']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('navigation', { name: 'App sections' }).first().getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  }
});

test('every /app page says it runs on demo data', async ({ page }) => {
  for (const path of ['trade', 'earn', 'portfolio', 'risk', 'agents']) {
    await page.goto(`/app/${path}`);
    const note = page.getByRole('note').filter({ hasText: 'Demo data' });
    await expect(note).toContainText('Demo data: computed with the Novation kernel reference.');
    await expect(note).toContainText('Nothing is sent to a chain.');
  }
});
