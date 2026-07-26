import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the `@/*` alias from tsconfig.json. Native since Vite 8, which
  // replaces the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node', // Integration tests often just need Node, not JSDOM, unless testing UI against DB? Assuming API/Service level.
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60000, // Longer timeout for DB ops
  },
});
