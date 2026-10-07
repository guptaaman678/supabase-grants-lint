import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    engine: 'src/engine.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // tsup's dts worker sets `baseUrl`, which TypeScript 6 reports as deprecated.
  dts: {
    entry: { index: 'src/index.ts', engine: 'src/engine.ts' },
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  clean: true,
  sourcemap: false,
  splitting: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
