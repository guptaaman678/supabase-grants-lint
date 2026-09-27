/**
 * Whole synthetic projects (spec T5.1, T11.2): `test/e2e/apps/<app>/` is a Supabase project
 * (`supabase/migrations/*.sql`, `supabase/schemas`, or a Drizzle or Prisma layout, optional
 * `grants-lint.config.json`) and `expected.json` lists runs of `check` with their exit code,
 * summary, resolved `since`, findings and notices.
 *
 * Each run goes through the built binary (`node <out>/cli/index.js check --format json`, cwd = the
 * project, so discovery and config use their defaults) and through `run()` in-process; both must
 * give the expected result and the same JSON. The pretty output must exit the same way and print
 * the same counts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Io } from '../../src/cli/io.js';
import { run } from '../../src/cli/main.js';
import type { JsonReport } from '../../src/index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APPS = path.join(ROOT, 'test/e2e/apps');
// A build of its own, so it never races the build of `cli.test.ts` in `dist/`. Inside the
// package, so the bundle resolves `libpg-query` from `node_modules`.
const OUT = path.join(ROOT, 'node_modules/.cache/supabase-grants-lint-e2e-apps');
const BIN = path.join(OUT, 'cli/index.js');

interface ExpectedRun {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly since: Readonly<Record<string, unknown>>;
  readonly summary: Readonly<Record<string, number>>;
  readonly findings: readonly Readonly<Record<string, unknown>>[];
  readonly notices: readonly Readonly<Record<string, unknown>>[];
}

interface Expected {
  readonly description: string;
  readonly runs: readonly ExpectedRun[];
}

const apps = readdirSync(APPS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

beforeAll(() => {
  execFileSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/tsup/dist/cli-default.js'), '--out-dir', OUT],
    { cwd: ROOT, stdio: 'ignore' },
  );
}, 60_000);

function binary(dir: string, args: readonly string[]) {
  const env = { ...process.env };
  delete env.NO_COLOR;
  const result = spawnSync(process.execPath, [BIN, 'check', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function inProcess(dir: string, args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: dir,
    env: {},
    isTTY: false,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  const code = await run(['check', ...args], io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** The JSON report without the one field that differs between runs. */
function stable(stdout: string): JsonReport {
  const report = JSON.parse(stdout) as JsonReport;
  return { ...report, summary: { ...report.summary, durationMs: 0 } };
}

function pick(report: JsonReport) {
  return {
    findings: report.findings.map((f) => ({
      rule: f.ruleId,
      severity: f.severity,
      file: f.file,
      line: f.line,
      column: f.column,
      ...(f.relation === undefined ? {} : { relation: f.relation }),
      ...(f.role === undefined ? {} : { role: f.role }),
    })),
    notices: report.notices.map((n) => ({
      code: n.code,
      ...(n.file === undefined ? {} : { file: n.file }),
      ...(n.line === undefined ? {} : { line: n.line }),
    })),
  };
}

it('has the projects the suite promises', () => {
  expect(apps).toEqual([
    'chat-app',
    'declarative-app',
    'declarative-only',
    'drizzle-app',
    'multi-schema-app',
    'prisma-app',
    'pulled-baseline',
    'todo-app',
  ]);
});

describe.each(apps)('%s', (app) => {
  const dir = path.join(APPS, app);
  const expected = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8')) as Expected;

  it.each(expected.runs.map((r) => [r.args.join(' ') || '(no flags)', r] as const))(
    'check %s',
    async (_, want) => {
      const json = ['--format', 'json', ...want.args];
      const bin = binary(dir, json);
      expect(bin.stderr).toBe('');
      expect(bin.code).toBe(want.exitCode);
      const report = stable(bin.stdout);
      expect(pick(report)).toEqual({ findings: want.findings, notices: want.notices });
      expect(report.summary).toEqual({
        ...want.summary,
        durationMs: 0,
        since: expect.objectContaining(want.since) as unknown,
      });

      const local = await inProcess(dir, json);
      expect(local.stderr).toBe('');
      expect(local.code).toBe(want.exitCode);
      expect(stable(local.stdout)).toEqual(report);

      const pretty = binary(dir, want.args);
      expect(pretty.code).toBe(want.exitCode);
      const { errors, warnings, files, relations } = want.summary;
      expect(pretty.stdout).toContain(
        `${String(errors)} error${errors === 1 ? '' : 's'}, ` +
          `${String(warnings)} warning${warnings === 1 ? '' : 's'}  ` +
          `(${String(files)} files, ${String(relations)} relation${relations === 1 ? '' : 's'}, `,
      );
    },
  );
});
