import { defineConfig } from 'vitest/config';

// Tests the whole src tree (engine / cli).
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
