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
          // the SDK's fixture: anvil, KernelReference as the kernel, then the repo's deploy and seed scripts
          globalSetup: ['../sdk/test/anvil/setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
