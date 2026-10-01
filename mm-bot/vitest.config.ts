import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
      {
        extends: true,
        test: {
          name: 'anvil',
          include: ['test/anvil/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/anvil/setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
