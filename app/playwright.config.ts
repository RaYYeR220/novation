import { defineConfig } from '@playwright/test';

// E2E_PORT lets parallel worktrees run their own server without reusing each other's.
const port = Number(process.env.E2E_PORT ?? 3000);
const url = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  webServer: { command: `pnpm build && pnpm start -p ${port}`, url, reuseExistingServer: true },
  use: { baseURL: url },
});
