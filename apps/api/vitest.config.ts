import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Native file fixtures take longer on Windows. Keep Linux CI budgets intact.
    ...(process.platform === 'win32' ? { maxWorkers: 1, testTimeout: 15000, hookTimeout: 30000 } : {}),
  },
});
