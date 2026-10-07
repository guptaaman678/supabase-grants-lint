import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Live-mode tests start a real Postgres (PGlite) per test, which takes seconds on a busy
    // CI runner; the 5 s default only guards against hangs.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        // The whole package (spec T5.1). Code only the child-process e2e tests run is not measured.
        lines: 90,
        // Every rule reads the model, so every branch of it is tested (spec T2.4).
        'src/model/**': { branches: 100, functions: 100, lines: 100, statements: 100 },
        // Every statement family the replay handles has a test (spec T2.5).
        'src/replay/**': { branches: 100, functions: 100, lines: 100, statements: 100 },
        // Severities, suppressions and ordering apply to every finding (spec T3.0).
        'src/rules/**': { branches: 100, functions: 100, lines: 100, statements: 100 },
        'src/fix/**': { branches: 100, functions: 100, lines: 100, statements: 100 },
        // The engine export and its snapshot are a library API (docs/engine.md).
        'src/{engine,snapshot}.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
        // Live mode's parsing and comparison; `read.ts` talks to Postgres (spec T11.1).
        'src/live/{acl-text,snapshot,url}.ts': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
