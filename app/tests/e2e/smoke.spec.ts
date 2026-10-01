import { test, expect } from '@playwright/test';

test('root renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
});
