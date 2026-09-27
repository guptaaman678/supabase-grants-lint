/**
 * Live mode against a real Postgres (spec T11.1): PGlite in-process by default, the CI service
 * container when `GRANTS_LINT_TEST_DB_URL` is set (see `test/support/database.ts`).
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { Io } from '../../src/cli/io.js';
import { run } from '../../src/cli/main.js';
import { diagnose } from '../../src/doctor.js';
import { drift } from '../../src/drift.js';
import { readCatalog } from '../../src/live/read.js';
import { buildSnapshot } from '../../src/live/snapshot.js';
import { PUBLIC } from '../../src/model/acl.js';
import { startDatabase, type TestDatabase } from '../support/database.js';
import { databaseFor } from '../support/live-project.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every sample project in the repo whose migrations Postgres accepts (`golden/projects/mixed` and
 * `e2e/projects/unparseable` hold syntax errors on purpose).
 */
const PROJECTS = [
  ...['clean', 'errors', 'warnings'].map((p) => `test/e2e/projects/${p}`),
  ...readdirSync(path.join(ROOT, 'test/e2e/apps')).map((p) => `test/e2e/apps/${p}`),
  ...['baseline', 'clean'].map((p) => `test/golden/projects/${p}`),
  'media/demo',
];

/** Drift a project's own migrations cause: SQL the replay reports as not modelled. */
const EXPECTED: Readonly<Record<string, readonly (string | undefined)[][]>> = {
  // The `do` block's dynamic `grant select on public.rooms to anon` (PARSE002) runs in the database.
  'test/e2e/apps/chat-app': [['public.rooms', 'anon', 'select']],
};

let open: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(open.map((db) => db.close()));
  open = [];
});

async function database(sql?: string): Promise<TestDatabase> {
  const db = await startDatabase();
  open.push(db);
  if (sql !== undefined) await db.exec(sql);
  return db;
}

async function project(dir: string, byHand: string[] = []): Promise<TestDatabase> {
  const db = await databaseFor(path.join(ROOT, dir), byHand);
  open.push(db);
  return db;
}

describe('readCatalog', () => {
  it('reads relation, column and default ACLs and policies in the given schemas only', async () => {
    const db = await database(`
      create table public.todos (id bigserial primary key, title text);
      revoke delete on public.todos from anon;
      grant select on public.todos to public;
      grant update (title) on public.todos to authenticated;
      create table public.events (id int generated always as identity, at date)
        partition by range (at);
      create table public.events_2026 partition of public.events
        for values from ('2026-01-01') to ('2027-01-01');
      create view public.open_todos as select * from public.todos;
      create materialized view public.counts as select count(*) from public.todos;
      create temporary table scratch (id int);
      create table private_x (id int);
      alter table private_x set schema auth;
      alter table public.todos enable row level security;
      create policy "own" on public.todos for update to authenticated using (true);
      create policy "all" on public.todos using (true);
      alter default privileges for role postgres grant select on tables to service_role;
    `);
    const raw = await readCatalog(db.url, ['public']);
    expect(raw.serverVersion).toBeGreaterThanOrEqual(150000);
    expect(raw.relations.map((r) => [r.name, r.relkind])).toEqual([
      ['counts', 'm'],
      ['events', 'p'],
      ['events_2026', 'r'],
      ['open_todos', 'v'],
      ['todos', 'r'],
      ['todos_id_seq', 'S'],
    ]);
    const live = buildSnapshot(raw);
    const todos = live.relations.find((r) => r.name === 'todos');
    expect(todos?.acl.holdsOwn('anon', 'delete')).toBe(false);
    expect(todos?.acl.holdsOwn('anon', 'insert')).toBe(true);
    expect(todos?.acl.holdsOwn(PUBLIC, 'select')).toBe(true);
    expect(todos?.acl.columnScoped('authenticated', 'update')).toBe(false);
    expect(raw.columns).toEqual([
      { schema: 'public', name: 'todos', column: 'title', acl: ['authenticated=w/postgres'] },
    ]);
    expect(live.sequences[0]?.acl.holdsOwn('anon', 'usage')).toBe(true);
    expect(live.defaults.effective('postgres', 'public', 'table').holdsOwn('anon', 'select')).toBe(
      true,
    );
    expect(live.defaults.entry('postgres', null, 'table').privileges('service_role')).toEqual([
      'select',
    ]);
    expect(live.policies.map((p) => [p.name, p.command, p.roles])).toEqual([
      ['all', 'all', [PUBLIC]],
      ['own', 'update', ['authenticated']],
    ]);
  });

  it('runs on the Postgres server CI provides, when it provides one', async () => {
    const db = await database();
    const { serverVersion } = await readCatalog(db.url, ['public']);
    const major = process.env.GRANTS_LINT_TEST_PG_MAJOR;
    if (major === undefined) expect(serverVersion).toBeGreaterThanOrEqual(150000);
    else expect(Math.floor(serverVersion / 10000)).toBe(Number(major));
  });

  it('never shows the password when it cannot connect (G12)', async () => {
    const url = 'postgres://reader:hunter2-secret@127.0.0.1:1/postgres';
    let error: unknown;
    try {
      await readCatalog(url, ['public']);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ name: 'UsageError', exitCode: 2 });
    expect((error as Error).message).toMatch(/^Could not read the database: /);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('needs no grants: a login role with read-only transactions reads everything', async () => {
    const db = await database(`
      create table public.todos (id int);
      do $$ begin
        create role grants_lint_reader with login password 'reader-pass';
      exception when duplicate_object then null; end $$;
      alter role grants_lint_reader set default_transaction_read_only = on;
    `);
    const url = new URL(db.url);
    url.username = 'grants_lint_reader';
    url.password = 'reader-pass';
    // An explicit sslmode in the URL replaces the default "prefer TLS".
    url.searchParams.set('sslmode', 'disable');
    const raw = await readCatalog(url.toString(), ['public']);
    expect(raw.relations.map((r) => [r.name, r.acl?.length])).toEqual([['todos', 4]]);
    expect(raw.defaults.length).toBeGreaterThan(0);
  });
});

describe('drift against the database its migrations built', () => {
  it.each(PROJECTS)('%s: the replay model equals the database', async (dir) => {
    const db = await project(dir);
    const result = await drift({ cwd: ROOT, dir, dbUrl: db.url });
    expect(result.findings.map((f) => [f.relation, f.role, f.privilege])).toEqual(
      EXPECTED[dir] ?? [],
    );
  });

  it('reports what was changed by hand, and nothing else', async () => {
    const dir = 'test/e2e/projects/clean';
    const db = await project(dir, [
      'grant truncate on public.todos to anon;',
      'revoke select on public.todos from service_role;',
      'create table public.notes (id int);',
    ]);
    const result = await drift({ cwd: ROOT, dir, dbUrl: db.url });
    expect(
      result.findings.map((f) => [f.relation, f.role, f.privilege, f.message.split(':')[0]]),
    ).toEqual([
      ['public.notes', undefined, undefined, 'In the database, not in the migrations'],
      ['public.todos', 'anon', 'truncate', 'In the database, not in the migrations'],
      ['public.todos', 'service_role', 'select', 'In the migrations, not in the database'],
    ]);
    expect(result.summary.warnings).toBe(3);
  });

  it('runs as the diff command in-process, with --max-warnings and every flag', async () => {
    const dir = 'test/e2e/projects/clean';
    const db = await project(dir, ['grant truncate on public.todos to anon;']);
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      cwd: ROOT,
      env: { SUPABASE_DB_URL: db.url },
      isTTY: false,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    };
    const args = ['diff', '--dir', dir, '--config', `${dir}/none.json`];
    expect(await run(args, io)).toBe(ExitCode.Usage); // the config file does not exist
    out.length = 0;
    err.length = 0;
    const flags = ['--since', 'none', '--schema', 'public', '--no-color', '--quiet'];
    expect(await run(['diff', '--dir', dir, ...flags, '--format', 'json'], io)).toBe(ExitCode.Ok);
    // --quiet reports errors only; drift is a warning.
    expect(JSON.parse(out.join(''))).toMatchObject({ findings: [], summary: { warnings: 1 } });
    out.length = 0;
    expect(await run(['diff', '--dir', dir, '--max-warnings', '0'], io)).toBe(ExitCode.Findings);
    expect(out.join('')).toContain('anon holds truncate on public.todos');
    expect(err.join('')).toBe('');
    expect(out.join('')).not.toContain(new URL(db.url).password);
  });

  it('feeds doctor: automatic grants in the database and the drift count', async () => {
    // Legacy defaults in the database, no opt-in migration: drift-free, and not opted in.
    const legacy = await project('test/e2e/apps/pulled-baseline');
    const before = await diagnose({
      cwd: ROOT,
      dir: 'test/e2e/apps/pulled-baseline',
      dbUrl: legacy.url,
    });
    expect(before.live).toEqual({
      serverVersion: expect.any(Number) as number,
      autoGrants: [{ schema: 'public', roles: ['anon', 'authenticated', 'service_role'] }],
      drift: 0,
    });
    // Opted in by hand (the dashboard): every default privilege the migrations keep is drift.
    const optedIn = await project('test/e2e/apps/pulled-baseline', [
      'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;',
    ]);
    const after = await diagnose({
      cwd: ROOT,
      dir: 'test/e2e/apps/pulled-baseline',
      dbUrl: optedIn.url,
    });
    expect(after.live?.autoGrants).toEqual([{ schema: 'public', roles: [] }]);
    expect(after.live?.drift).toBe(3);
  });
});
