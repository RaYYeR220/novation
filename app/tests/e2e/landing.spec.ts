import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Software WebGL so the crown can go live in headless Chromium without a GPU.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

const axePath = path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  return errors;
}

/** Walks the page top to bottom so lazy pieces mount and the scroll-linked reveals run. */
async function scrollThrough(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = await page.evaluate(() => Math.round(window.innerHeight * 0.7));
  for (let y = 0; y <= height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  }
}

/**
 * Tables a sighted reader can see: the part of each table left after clipping by its overflow
 * ancestors (the screen-reader twins of the charts sit in 1px clipped boxes) must have real area.
 */
async function visibleTables(page: Page) {
  return page.evaluate(() => {
    const out: { top: number; bottom: number; area: number }[] = [];
    for (const t of Array.from(document.querySelectorAll('table'))) {
      let r = t.getBoundingClientRect();
      let left = r.left;
      let top = r.top;
      let right = r.right;
      let bottom = r.bottom;
      for (let a = t.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.display === 'none' || cs.visibility === 'hidden') {
          right = left;
          break;
        }
        if (cs.overflow !== 'visible' || cs.clip !== 'auto') {
          r = a.getBoundingClientRect();
          left = Math.max(left, r.left);
          top = Math.max(top, r.top);
          right = Math.min(right, r.right);
          bottom = Math.min(bottom, r.bottom);
        }
      }
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      if (area > 4) out.push({ top: top + window.scrollY, bottom: bottom + window.scrollY, area });
    }
    return out;
  });
}

test.describe('landing', () => {
  test('loads without console errors, scrolled end to end', async ({ page }) => {
    test.slow();
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The other side of every trade, stress-tested first.');
    const crown = page.locator('figure[data-variant="hero"]');
    // the 3D view waits for a visitor: until then the poster stands in
    await page.waitForTimeout(1500);
    await expect(crown).toHaveAttribute('data-crown-phase', 'poster');
    await page.mouse.move(4, 4);
    await expect(crown).toHaveAttribute('data-crown-phase', /live|static/, { timeout: 45_000 });
    await scrollThrough(page);
    await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('demo figures match the app pages: account 7 margin, the agent refusal, the protocol strip', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    // the hero crown: the same 596.51 -> 1,373.29 that /app/portfolio shows
    const crown = page.locator('figure[data-variant="hero"]');
    await expect(crown.getByRole('table')).toContainText('Regular session. Initial margin 596.51 USDG');
    const breaks = page.locator('section[aria-labelledby="when-it-breaks"]');
    await expect(breaks).toContainText('596.51 USDG of initial margin on a weekday and 1,373.29 over the weekend');
    // the over-budget agent: the worst case after the ticket against the budget, as /app/risk and /app/agents show it
    await expect(breaks).toContainText('the hedge-bot agent tries to sell 60 NVDA 200 calls for account 7');
    await expect(breaks).toContainText('comes to 1,762.72 USDG, past the agent’s 1,500.00 USDG budget');
    const ways = page.locator('section[aria-labelledby="ways-in"]');
    await expect(ways).toContainText('works under a 1,500 USDG budget, and account 7 needs 596.51 today');
    const strip = page.locator('section[aria-labelledby="protocol"]');
    await expect(strip).toContainText('$1,440,901');
    await expect(strip).toContainText('$1,344,232');
    await expect(strip).toContainText('$5,662');
  });

  test('the primary CTA is reachable by keyboard and leads to the app', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const cta = page.getByRole('main').getByRole('link', { name: 'Open the app' }).first();
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await cta.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await expect(cta).toBeFocused();
    await expect(cta).toHaveAttribute('href', '/app/trade');
    // the focus ring is the cyan token
    const outline = await cta.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outline).toBe('rgb(16, 225, 255)');
    await expect(page.getByText('Stock tokens are not available to US persons.').first()).toBeVisible();
  });

  test('no data table above the fold; the protocol strip is the only figures row, far below', async ({ page }) => {
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 1280, height: 720 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      const tables = await visibleTables(page);
      expect(tables.filter((t) => t.top < vp.height), `visible table above the fold at ${vp.width}`).toEqual([]);
      const strip = page.getByRole('region', { name: 'Protocol' });
      const box = await strip.boundingBox();
      expect(box && box.y).toBeGreaterThan(vp.height * 3);
    }
  });

  test('no horizontal scroll at 390', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await scrollThrough(page);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(client);
  });

  test('every figure names its footnote, and every footnote exists', async ({ page }) => {
    await page.goto('/');
    const ids = await page.locator('[data-source]').evaluateAll((els) => els.map((e) => e.getAttribute('data-source')));
    expect(ids.length).toBeGreaterThan(10);
    for (const id of new Set(ids)) await expect(page.locator(`#${id}`)).toHaveCount(1);
    const refs = await page.locator('a[href^="#source-"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    for (const href of new Set(refs)) await expect(page.locator(href as string)).toHaveCount(1);
  });

  test('passes axe in the browser, contrast included', async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    await page.addScriptTag({ path: axePath });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
      return r.violations.map((v) => ({ id: v.id, targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }));
    });
    expect(violations).toEqual([]);
  });

  test('under reduced motion the novation diagram shows its final pose', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const fig = page.locator('#how-it-works').locator('xpath=ancestor::section').locator('figure').first();
    await fig.scrollIntoViewIfNeeded();
    await expect(fig).toHaveAttribute('data-state', 'static');
    await expect(page.getByRole('button', { name: 'Play the clearing again' })).toHaveCount(0);
    await expect(fig.getByRole('img')).toHaveAttribute('aria-label', /IM|initial margin/);
  });
});
