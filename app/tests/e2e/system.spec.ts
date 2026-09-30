import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const axePath = path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  // Still frames: no sweep or spin mid-capture.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/system');
  await page.evaluate(() => document.fonts.ready);
}

for (const { width, height } of VIEWPORTS) {
  test(`/system renders every primitive at ${width}px`, async ({ page }) => {
    await open(page, width, height);
    await expect(page.getByRole('heading', { level: 1, name: 'Every part, in every state.' })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    for (const name of ['Button', 'Segmented control', 'Tabs', 'Number field', 'Stat', 'Chip', 'Tooltip', 'Panel', 'Data table', 'Meter', 'Refusal card', 'Toast', 'Dialog', 'Skeleton']) {
      await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeAttached();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/system-${width}.png`, fullPage: true });
  });
}

test('/system passes axe in the browser, contrast included', async ({ page }) => {
  await open(page, 1440, 900);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
  });
  expect(violations).toEqual([]);
});

test('/system keyboard: segmented switch, tabs and dialog', async ({ page }) => {
  await open(page, 1440, 900);
  const live = page.getByRole('group', { name: 'Market session' });
  await live.getByRole('radio', { name: 'Regular' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(live.getByRole('radio', { name: 'Weekend' })).toBeChecked();
  await expect(page.getByText(/Weekend initial margin, account 7/)).toContainText('1,350.99');

  const tabs = page.getByRole('tablist', { name: 'Account 7' });
  await tabs.getByRole('tab', { name: /Positions/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Margin' })).toHaveAttribute('aria-selected', 'true');

  const opener = page.getByRole('button', { name: 'Revoke hedge-bot' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Revoke hedge-bot?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep grant' })).toBeFocused();
  // Tab order inside: Close, Keep grant, Revoke grant. Focus wraps both ways and never leaves.
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Revoke grant' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Revoke grant' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});
