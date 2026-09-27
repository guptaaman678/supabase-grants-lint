/**
 * Live mode through the built binary (spec T11.1): `diff` and `doctor --db-url` against a real
 * Postgres (see `test/support/database.ts`), exit codes, and that the connection string never
 * appears in any output (G12).
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '../support/database.js';
import { databaseFor } from '../support/live-project.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BIN = path.join(ROOT, 'dist/cli/index.js');
const PROJECT = 'test/e2e/projects/clean';

let db: TestDatabase;
let password: string;

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/tsup/dist/cli-default.js')], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  // A hand-made grant and a table made in the dashboard.
  db = await databaseFor(path.join(ROOT, PROJECT), [
    'grant truncate on public.todos to anon;',
    'create table public.notes (id int);',
  ]);
  password = new URL(db.url).password;
}, 120_000);

afterAll(async () => {
  await db.close();
});

/** Runs the CLI without blocking this process, which may be serving the database (PGlite). */
function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const inherited: Record<string, string | undefined> = { ...process.env, ...env };
  delete inherited.NO_COLOR;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: inherited });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function expectNoSecret(output: { stdout: string; stderr: string }): void {
  for (const text of [output.stdout, output.stderr]) {
    expect(text).not.toContain(password);
    expect(text).not.toContain(db.url);
  }
}

describe('diff', () => {
  it('reports drift as warnings (exit 0), reading SUPABASE_DB_URL', async () => {
    const result = await cli(['diff', '--dir', PROJECT], { SUPABASE_DB_URL: db.url });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /warn +GL009 +In the database, not in the migrations: anon holds truncate on public\.todos\./,
    );
    expect(result.stdout).toContain('table public.notes exists, but no migration creates it');
    expect(result.stdout).toMatch(/^0 errors, 2 warnings {2}\(2 files, 1 relation, /m);
    expectNoSecret(result);
  });

  it('fails CI on drift with --max-warnings 0, in every format; --db-url wins', async () => {
    const env = { SUPABASE_DB_URL: 'postgres://reader:hunter2-secret@127.0.0.1:1/postgres' };
    const github = await cli(
      ['diff', '--dir', PROJECT, '--db-url', db.url, '--max-warnings', '0', '--format', 'github'],
      env,
    );
    expect(github.code).toBe(1);
    expect(github.stdout).toMatch(/^::warning file=test\/e2e\/projects\/clean\/.*title=GL009::/m);
    expectNoSecret(github);
    const json = await cli(['diff', '--dir', PROJECT, '--db-url', db.url, '--format', 'json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ summary: { warnings: 2, errors: 0 } });
    const sarif = await cli(['diff', '--dir', PROJECT, '--db-url', db.url, '--format', 'sarif']);
    expect(sarif.stdout).toContain('"ruleId": "GL009"');
    expectNoSecret(json);
    expectNoSecret(sarif);
  });

  it('is a usage error (exit 2) without a database, or with a bad URL, never echoing it', async () => {
    const none = await cli(['diff', '--dir', PROJECT], { SUPABASE_DB_URL: undefined });
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(
      /^diff needs a database: pass --db-url <postgres-url> or set SUPABASE_DB_URL/,
    );
    const scheme = await cli(['diff', '--db-url', 'mysql://u:hunter2@h/db']);
    expect(scheme.code).toBe(2);
    expect(scheme.stderr).not.toContain('hunter2');
    const positional = await cli(['diff', 'postgres://u:hunter2@h/db']);
    expect(positional.code).toBe(2);
    expect(positional.stderr).toMatch(/^diff takes no arguments\./);
    expect(positional.stderr).not.toContain('hunter2');
  });

  it('is a usage error (exit 2) when it cannot connect, with the credentials removed', async () => {
    const result = await cli(['diff', '--dir', PROJECT], {
      SUPABASE_DB_URL: 'postgres://reader:hunter2-secret@127.0.0.1:1/postgres',
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Could not read the database: /);
    expect(result.stderr).not.toContain('hunter2');
  });

  it('prints its help', async () => {
    const result = await cli(['diff', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: supabase-grants-lint diff \[options\]/);
    expect(result.stdout).toContain('--db-url <url>');
  });
});

describe('doctor --db-url', () => {
  it('adds the Live database section', async () => {
    const result = await cli(['doctor', '--dir', PROJECT, '--db-url', db.url]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /\nLive database\n {2}Read the database \(Postgres \d+\.\d+\), read-only\.\n/,
    );
    expect(result.stdout).toContain(
      'New tables postgres creates in schema public get no automatic grants: the database is opted in',
    );
    expect(result.stdout).toMatch(
      /2 differences between the database and the migrations \(GL009\); run\s+supabase-grants-lint diff/,
    );
    expectNoSecret(result);
  });

  it('stays offline without a URL', async () => {
    const result = await cli(['doctor', '--dir', PROJECT], { SUPABASE_DB_URL: undefined });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('Live database');
  });
});
