import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only our tests: .cache/ holds cloned third-party repositories that may contain test files.
    include: ['tests/**/*.test.ts'],
  },
});
