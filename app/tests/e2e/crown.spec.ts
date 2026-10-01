import { test, expect, type Page } from '@playwright/test';

// Headless Chromium has no GPU in CI; SwiftShader gives it a software WebGL2 context.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

/** Counts requestAnimationFrame calls so a test can prove nothing is animating. */
async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const w = window as Window & { __raf?: number };
    w.__raf = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      w.__raf = (w.__raf ?? 0) + 1;
      return raf(cb);
    };
  });
}

const rafCount = (page: Page) => page.evaluate(() => (window as Window & { __raf?: number }).__raf ?? 0);

async function openLive(page: Page) {
  await page.goto('/crown-lab?view=hero');
  const crown = page.locator('figure[data-variant="hero"]');
  await expect(crown).toHaveAttribute('data-crown-phase', 'live', { timeout: 45_000 });
  return crown;
}

test('the crown mounts, switches session and logs no errors', async ({ page }) => {
  test.slow(); // software WebGL renders about one frame a second; the 900 ms spring needs a handful of them
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  const crown = await openLive(page);
  await expect(crown.locator('canvas')).toBeVisible();
  const stage = crown.getByRole('group', { name: /Scenario crown/ });
  await expect(stage).toHaveAttribute('data-frames', /\d+/);
  await expect(crown.getByText('596.51', { exact: true })).toBeVisible();

  await crown.getByRole('button', { name: 'Weekend' }).click();
  await expect(crown.getByRole('button', { name: 'Weekend' })).toHaveAttribute('aria-pressed', 'true');
  await expect(crown.getByRole('table')).toContainText('Weekend session. Initial margin 1,373.29 USDG');
  // the readout follows the spring and lands on the weekend IM
  await expect(crown.getByText('1,373.29', { exact: true })).toBeVisible({ timeout: 60_000 });

  // keyboard: arrows step through scenarios and announce them
  await stage.focus();
  await page.keyboard.press('ArrowRight');
  await expect(crown.getByText('price −5/6 R, vol ×0.7: −896.95 USDG')).toBeAttached();

  expect(errors).toEqual([]);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('renders a static pose: no animation frames run after load', async ({ page }) => {
    await countFrames(page);
    const crown = await openLive(page);
    const stage = crown.getByRole('group', { name: /Scenario crown/ });
    await page.waitForTimeout(600);
    const frames = await stage.getAttribute('data-frames');
    const raf = await rafCount(page);
    await page.waitForTimeout(1500);
    expect(await stage.getAttribute('data-frames')).toBe(frames);
    expect(await rafCount(page)).toBe(raf);

    // a session switch re-seats instantly: at most a couple of frames, then still again
    await crown.getByRole('button', { name: 'Weekend' }).click();
    await expect(crown.getByText('1,373.29', { exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    const after = Number(await stage.getAttribute('data-frames'));
    expect(after - Number(frames)).toBeLessThanOrEqual(4);
    await page.waitForTimeout(1000);
    expect(Number(await stage.getAttribute('data-frames'))).toBe(after);
  });
});

test('without reduced motion the idle turn keeps rendering', async ({ page }) => {
  test.slow();
  const crown = await openLive(page);
  const stage = crown.getByRole('group', { name: /Scenario crown/ });
  const a = Number(await stage.getAttribute('data-frames'));
  // software WebGL is slow, so poll instead of assuming a frame rate
  await expect.poll(async () => Number(await stage.getAttribute('data-frames')), { timeout: 30_000 }).toBeGreaterThan(a + 3);
});

test.describe('no WebGL', () => {
  test('falls back to the poster and keeps the data readable', async ({ page }) => {
    await page.addInitScript(() => {
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type.startsWith('webgl')) return null;
        return (get as (t: string, ...r: unknown[]) => RenderingContext | null).call(this, type, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    await page.goto('/crown-lab?view=hero');
    const crown = page.locator('figure[data-variant="hero"]');
    await expect(crown).toHaveAttribute('data-crown-phase', 'static', { timeout: 15_000 });
    await expect(crown.locator('canvas')).toHaveCount(0);
    await expect(crown.locator('img')).toBeVisible();
    await expect(crown.getByRole('table')).toContainText('−483.46');
  });
});
