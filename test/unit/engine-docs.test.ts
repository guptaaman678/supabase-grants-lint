/**
 * docs/engine.md's code blocks compile: the example against the engine export, and the types
 * block declares exactly the types and signatures `src/engine.ts` exports (each pair must be
 * assignable both ways).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const engine = path.join(root, 'src', 'engine.ts');
const temp = mkdtempSync(path.join(tmpdir(), 'grants-lint-engine-docs-'));
// The blocks are ES modules, like the package's users' code.
writeFileSync(path.join(temp, 'package.json'), '{ "type": "module" }');

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

const blocks = [
  ...readFileSync(path.join(root, 'docs', 'engine.md'), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g),
].map((match) => match[1] ?? '');

function diagnostics(files: Record<string, string>): string[] {
  const names = Object.entries(files).map(([name, text]) => {
    const file = path.join(temp, name);
    writeFileSync(file, text);
    return file;
  });
  // The repo's own compiler options, so `src/` type-checks as `npm run typecheck` checks it.
  const { config } = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile) as {
    config: unknown;
  };
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(names, {
    ...options,
    noEmit: true,
    typeRoots: [path.join(root, 'node_modules', '@types')],
    paths: { 'supabase-grants-lint/engine': [engine] },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('docs/engine.md', () => {
  it('has the example and the types block', () => {
    expect(blocks).toHaveLength(2);
  });

  it('compiles the example', () => {
    expect(diagnostics({ 'example.ts': blocks[0] ?? '' })).toEqual([]);
  });

  it('declares the types and signatures src/engine.ts exports', () => {
    const block = blocks[1] ?? '';
    const types = [...block.matchAll(/^export (?:interface|type|declare class) (\w+)/gm)].map(
      (m) => m[1] ?? '',
    );
    const values = [...block.matchAll(/^export declare (?:function|const) (\w+)/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(types).toEqual(
      expect.arrayContaining(['SchemaSnapshot', 'ReplayProjectOptions', 'EngineError']),
    );
    expect(values).toEqual(expect.arrayContaining(['replayProjectSync', 'version']));
    const checks = [
      `import type * as Engine from ${JSON.stringify(engine.replace(/\.ts$/, '.js'))};`,
      `import type * as Doc from './doc-types.js';`,
      'type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;',
      ...types.map((t) => `export const type_${t}: Same<Doc.${t}, Engine.${t}> = true;`),
      ...values.map(
        (v) => `export const value_${v}: Same<typeof Doc.${v}, typeof Engine.${v}> = true;`,
      ),
    ].join('\n');
    expect(diagnostics({ 'doc-types.ts': block, 'checks.ts': checks })).toEqual([]);
  });
});
