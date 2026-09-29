/**
 * End-to-end tests of the built binary (spec T4.1): builds the package once, then runs
 * `node dist/cli/index.js` in a child process for each exit code of the CLI contract (§6.3).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = path.join(ROOT, 'dist/cli/index.js');
const PROJECTS = 'test/e2e/projects';
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/tsup/dist/cli-default.js')], {
    cwd: ROOT,
    stdio: 'ignore',
  });
}, 60_000);

function cli(args: string[], env: Record<string, string> = {}, cwd = ROOT) {
  const inherited = { ...process.env };
  delete inherited.NO_COLOR;
  // doctor reads a live database when this is set (T11.1); these tests stay offline (G4).
  delete inherited.SUPABASE_DB_URL;
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...inherited, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('exit code 0', () => {
  it('prints the version', () => {
    expect(cli(['--version'])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  });

  it('prints help with commands, examples and rules', () => {
    for (const args of [[], ['--help'], ['-h'], ['help']]) {
      const { code, stdout } = cli(args);
      expect(code).toBe(0);
      expect(stdout).toMatch(/^Usage: supabase-grants-lint <command>/);
      expect(stdout).toContain('Examples:');
      expect(stdout).toMatch(/^ {2}GL001 +missing-service-role-grant +error$/m);
    }
  });

  it('prints help per command', () => {
    for (const command of ['check', 'doctor', 'explain', 'init']) {
      const { code, stdout } = cli([command, '--help']);
      expect(code).toBe(0);
      expect(stdout).toMatch(new RegExp(`^Usage: supabase-grants-lint ${command}`));
    }
  });

  it('checks a project without findings', () => {
    const { code, stdout, stderr } = cli(['check', '--dir', `${PROJECTS}/clean`]);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/^0 errors, 0 warnings {2}\(2 files, 1 relation, [0-9.]+s\)\n$/);
    expect(code).toBe(0);
  });

  it('runs doctor on a project that check fails, and still exits 0', () => {
    const dir = 'test/golden/doctor/projects/replay-trap';
    expect(cli(['check', '--dir', dir]).code).toBe(1);
    const { code, stdout, stderr } = cli(['doctor', '--dir', dir]);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/^supabase-grants-lint doctor: readiness for 2026-10-30\n/);
    expect(stdout.replace(/\n +/g, ' ')).toContain(
      `GL007 error at ${dir}/supabase/migrations/20261005000000_audit_log.sql:1:`,
    );
    expect(stdout).not.toContain('\u001b[');
    expect(code).toBe(0);
  });

  it('allows warnings when --max-warnings is not given or not exceeded', () => {
    expect(cli(['check', '--dir', `${PROJECTS}/warnings`]).code).toBe(0);
    expect(cli(['check', '--dir', `${PROJECTS}/warnings`, '--max-warnings', '1']).code).toBe(0);
  });

  it('reports unparseable SQL as info without --strict-parse', () => {
    const { code, stdout } = cli(['check', '--dir', `${PROJECTS}/unparseable`]);
    expect(stdout).toMatch(/6:1 +info +PARSE001/);
    expect(code).toBe(0);
  });
});

describe('exit code 1', () => {
  it('fails on an error finding', () => {
    const { code, stdout } = cli(['check', '--dir', `${PROJECTS}/errors`]);
    expect(stdout).toMatch(/1:1 +error +GL001 +public\.todos is created without a grant/);
    expect(stdout).toContain(
      'fix   grant select, insert, update, delete on public.todos to service_role;',
    );
    expect(stdout).toMatch(/^1 error, 0 warnings/m);
    expect(code).toBe(1);
  });

  it('fails when warnings exceed --max-warnings', () => {
    const { code, stdout } = cli(['check', '--dir', `${PROJECTS}/warnings`, '--max-warnings=0']);
    expect(stdout).toMatch(/7:1 +warn +GL005/);
    expect(code).toBe(1);
  });

  it('still fails under --quiet, which prints errors only', () => {
    const errors = cli(['check', '--dir', `${PROJECTS}/errors`, '--quiet']);
    expect(errors.code).toBe(1);
    expect(errors.stdout).toContain('GL001');
    const warnings = cli(['check', '--dir', `${PROJECTS}/warnings`, '--quiet']);
    expect(warnings.stdout).not.toContain('GL005');
    expect(warnings.code).toBe(0);
  });
});

describe('exit code 2', () => {
  it.each([
    [['check', '--frmat', 'json'], 'Unknown option --frmat for check. Did you mean "--format"?'],
    [['chek'], 'Unknown command "chek". Did you mean "check"?'],
    [['--verison'], 'Unknown option --verison for supabase-grants-lint. Did you mean "--version"?'],
    [['check', '--format', 'yaml'], 'must be one of pretty, json, sarif, github, got "yaml"'],
    [['check', '--format'], 'Option --format needs a value.'],
    [['check', '--quiet=yes'], 'Option --quiet does not take a value.'],
    [['check', '--max-warnings', 'ten'], '--max-warnings must be a whole number'],
    [['check', '--since', 'yesterday'], 'Invalid config in --since'],
    [['check', 'supabase'], 'check takes no arguments'],
    [['check', '--dir', 'no/such/project'], 'Migrations directory not found'],
    [['check', '--dir', `${PROJECTS}/bad-config`], 'Did you mean "platformDefaults"?'],
    [['check', '--dir', `${PROJECTS}/clean`, '--config', 'missing.json'], 'file not found'],
  ])('%j', (args, message) => {
    const { code, stdout, stderr } = cli(args);
    expect(stdout).toBe('');
    expect(stderr).toContain(message);
    expect(stderr).toContain('Run "supabase-grants-lint --help" for usage.');
    expect(code).toBe(2);
  });
});

describe('init then check (T4.8)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'grants-lint-e2e-init-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function project(name: string, from?: string): string {
    const dir = path.join(tmp, name);
    if (from === undefined) mkdirSync(path.join(dir, 'supabase/migrations'), { recursive: true });
    else cpSync(path.join(ROOT, PROJECTS, from), dir, { recursive: true });
    return dir;
  }

  it('a fresh project with no migrations yet', () => {
    const dir = project('fresh');
    const init = cli(['init', '--dir', dir]);
    expect(init.stderr).toBe('');
    expect(init.code).toBe(0);
    expect(existsSync(path.join(dir, '.github/workflows/grants-lint.yml'))).toBe(true);
    const { code, stderr } = cli(['check', '--dir', dir]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  it('a clean project, auto-detecting the opt-in', () => {
    const dir = project('clean', 'clean');
    expect(cli(['init', '--dir', dir]).code).toBe(0);
    expect(cli(['check', '--dir', dir]).code).toBe(0);
  });

  it('--since next accepts the existing history and enforces what comes after', () => {
    const dir = project('errors', 'errors');
    expect(cli(['check', '--dir', dir]).code).toBe(1);
    const init = cli(['init', '--dir', dir, '--since', 'next', '--no-workflow']);
    expect(init.stdout).toMatch(/^Wrote .*grants-lint\.config\.json \(since \d{14}\)\n/);
    expect(init.code).toBe(0);
    expect(cli(['check', '--dir', dir]).code).toBe(0);
    writeFileSync(
      path.join(dir, 'supabase/migrations/29991231000000_add_orders.sql'),
      'create table public.orders (id bigint primary key);\n',
    );
    expect(cli(['check', '--dir', dir]).code).toBe(1);
  });

  it('refuses to overwrite without --force (exit 2), then overwrites with it', () => {
    const dir = project('twice');
    expect(cli(['init', '--dir', dir]).code).toBe(0);
    const again = cli(['init', '--dir', dir]);
    expect(again.stdout).toBe('');
    expect(again.stderr).toContain('already exist; nothing was written.');
    expect(again.code).toBe(2);
    expect(cli(['init', '--dir', dir, '--force', '--since', 'none']).code).toBe(0);
    expect(readFileSync(path.join(dir, 'grants-lint.config.json'), 'utf8')).toContain(
      '"since": "none"',
    );
  });
});

describe('running without --dir (T9.8)', () => {
  const nested = path.join(ROOT, PROJECTS, 'nested');
  const sqlFolder = path.join(ROOT, PROJECTS, 'sql-folder');
  const summary = (stdout: string) => stdout.trim().split('\n').at(-1);
  const findings = (stdout: string) =>
    (JSON.parse(stdout) as { findings: { ruleId: string; file: string; line: number }[] }).findings;

  it('from the project root: supabase/migrations, config read, no location in the summary', () => {
    const { code, stdout, stderr } = cli(['check'], {}, nested);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/warn +GL001 +public\.todos/);
    expect(summary(stdout)).toMatch(/^0 errors, 1 warning {2}\(2 files, 1 relation, [0-9.]+s\)$/);
    expect(code).toBe(0);
  });

  it.each([
    ['supabase', '..'],
    ['supabase/migrations', '../..'],
  ])('from %s: finds the project root above, reads its config, skips seed.sql', (sub, up) => {
    const cwd = path.join(nested, sub);
    const { code, stdout, stderr } = cli(['check'], {}, cwd);
    expect(stderr).toBe('');
    expect(stdout).toMatch(/warn +GL001 +public\.todos/);
    expect(stdout).not.toContain('seed.sql');
    expect(summary(stdout)).toMatch(/^0 errors, 1 warning {2}\(2 files, 1 relation, [0-9.]+s, /);
    expect(summary(stdout)?.endsWith(`s, project root ${up})`)).toBe(true);
    expect(code).toBe(0);
    const doctor = cli(['doctor'], {}, cwd);
    expect(doctor.stdout).toContain(`Replayed 2 migration files (project root ${up}):`);
    expect(doctor.code).toBe(0);
    const json = cli(['check', '--format', 'json'], {}, cwd);
    expect(findings(json.stdout)).toEqual(
      findings(cli(['check', '--format', 'json', '--dir', '.'], {}, nested).stdout).map((f) => ({
        ...f,
        file: path.posix.relative(sub, f.file),
      })),
    );
  });

  it('from a folder of .sql files with no supabase/: the same as --dir <that folder>', () => {
    const plain = cli(['check', '--format', 'json'], {}, sqlFolder);
    const withDir = cli(['check', '--format', 'json', '--dir', '.'], {}, sqlFolder);
    const fromRoot = cli(['check', '--format', 'json', '--dir', `${PROJECTS}/sql-folder`]);
    expect(plain.code).toBe(1);
    expect(withDir.code).toBe(1);
    expect(fromRoot.code).toBe(1);
    expect(findings(plain.stdout)).toEqual(findings(withDir.stdout));
    expect(findings(plain.stdout)).toEqual(
      findings(fromRoot.stdout).map((f) => ({ ...f, file: path.posix.basename(f.file) })),
    );
    expect(findings(plain.stdout).map((f) => f.ruleId)).toEqual(['GL001']);
    expect(summary(cli(['check'], {}, sqlFolder).stdout)).toMatch(/, migrations folder \.\)$/);
  });

  it('elsewhere: exit 2 naming both options', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'grants-lint-e2e-empty-'));
    try {
      const { code, stdout, stderr } = cli(['check'], {}, empty);
      expect(stdout).toBe('');
      expect(stderr).toContain(
        'Migrations directory not found: supabase/migrations. Run from the project root ' +
          '(the folder that contains supabase/), or pass --dir <project or migrations folder>.',
      );
      expect(code).toBe(2);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('exit code 3', () => {
  it('fails on unparseable SQL under --strict-parse', () => {
    const { code, stdout } = cli(['check', '--dir', `${PROJECTS}/unparseable`, '--strict-parse']);
    expect(stdout).toMatch(/6:1 +error +PARSE001/);
    expect(code).toBe(3);
  });
});

describe('output', () => {
  it('has no colour when output is not a terminal, and none under NO_COLOR', () => {
    const args = ['check', '--dir', `${PROJECTS}/errors`];
    // eslint-disable-next-line no-control-regex
    const ansi = /\u001b\[/;
    expect(cli(args).stdout).not.toMatch(ansi);
    expect(cli(args, { NO_COLOR: '1' }).stdout).not.toMatch(ansi);
    expect(cli([...args, '--no-color']).stdout).not.toMatch(ansi);
  });

  it('prints every --format and keeps the exit code', () => {
    const dir = `${PROJECTS}/errors`;
    const json = cli(['check', '--dir', dir, '--format', 'json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      tool: { name: 'supabase-grants-lint', version: pkg.version },
      summary: { errors: 1 },
    });
    const sarif = cli(['check', '--dir', dir, '--format=sarif']);
    expect(sarif.code).toBe(1);
    expect(JSON.parse(sarif.stdout)).toMatchObject({ version: '2.1.0' });
    const github = cli(['check', '--dir', dir, '--format', 'github']);
    expect(github.code).toBe(1);
    expect(github.stdout).toMatch(
      /^::error file=test\/e2e\/projects\/errors\/supabase\/migrations\/\d+_add_todos\.sql,line=1,col=1,title=GL001::/,
    );
    expect(cli(['check', '--dir', `${PROJECTS}/clean`, '--format', 'json']).code).toBe(0);
  });

  /** Every file and package `file` imports statically, transitively. */
  function staticImports(file: string, imports = new Set<string>()): Set<string> {
    if (imports.has(file)) return imports;
    imports.add(file);
    const source = readFileSync(file, 'utf8');
    // Static imports only: `import ... from "x"` at the start of a line.
    for (const [, spec] of source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)) {
      if (spec?.startsWith('.') === true) {
        staticImports(path.resolve(path.dirname(file), spec), imports);
      } else if (spec !== undefined) imports.add(spec);
    }
    return imports;
  }

  it('loads the parser only for commands that lint', () => {
    const imports = staticImports(BIN);
    expect([...imports]).not.toContain('libpg-query');
    expect([...imports]).not.toContain('postgres');
    expect(readFileSync(BIN, 'utf8')).toMatch(/import\("\.\.\/lint-[A-Z0-9]+\.js"\)/);
  });

  it('never loads the Postgres client for check, only in live mode (G4)', () => {
    const chunk = /import\("\.\.\/(lint-[A-Z0-9]+\.js)"\)/.exec(readFileSync(BIN, 'utf8'))?.[1];
    expect(chunk).toBeDefined();
    const imports = staticImports(path.join(ROOT, 'dist', chunk ?? ''));
    expect([...imports]).toContain('libpg-query');
    expect([...imports]).not.toContain('postgres');
    const loadsClient = [...imports].filter(
      (file) => file.startsWith(ROOT) && readFileSync(file, 'utf8').includes('import("postgres")'),
    );
    expect(loadsClient).toEqual([]);
  });
});
