import { defineConfig } from '@playwright/test';

// E2E_PORT lets parallel worktrees run their own server without reusing each other's.
const port = Number(process.env.E2E_PORT ?? 3000);
const url = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  // the build runs a full type check first: on a busy machine it takes longer than the 60 s default
  webServer: { command: `pnpm build && pnpm start -p ${port}`, url, reuseExistingServer: true, timeout: 180_000 },
  use: { baseURL: url },
});
