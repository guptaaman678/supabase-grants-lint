import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Used by Stryker (`npm run mutation`). Stryker switches mutants inside the test process, so
// tests that build the CLI and run it in a child process never see an active mutant; they only
// slow every run down with a tsup build. The in-process unit, golden and fixture suites exercise
// the same code paths. (mergeConfig would append to `include`, so the object is spread.)
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/unit/**/*.test.ts', 'test/golden/**/*.test.ts', 'test/live/**/*.test.ts'],
    setupFiles: ['test/stryker-name-filter.ts'],
  },
});
