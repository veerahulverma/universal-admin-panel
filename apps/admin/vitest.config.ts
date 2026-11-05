import { defineConfig } from 'vitest/config';

// Unit tests for the console's shared logic (no browser needed).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
