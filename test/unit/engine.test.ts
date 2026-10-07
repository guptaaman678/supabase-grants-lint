/**
 * The engine export (`supabase-grants-lint/engine`): loading, the replay as `check` runs it, the
 * snapshot's content and determinism, errors, and the inputs a cache watches.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  EngineError,
  isEngineLoaded,
  listReplayInputs,
  loadEngine,
  replayProject,
  replayProjectSync,
  version,
} from '../../src/engine.js';
import { ConfigError } from '../../src/errors.js';
import { loadProject } from '../../src/lint.js';

const temp = mkdtempSync(path.join(tmpdir(), 'grants-lint-engine-'));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

let counter = 0;

/** A project with the given migrations (name -> SQL) under `supabase/migrations`, and files. */
function project(
  migrations: Record<string, string>,
  files: Record<string, string> = {},
  migrationsDir = 'supabase/migrations',
): string {
  counter += 1;
  const dir = path.join(temp, `p${String(counter)}`);
  mkdirSync(path.join(dir, migrationsDir), { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(path.join(dir, migrationsDir, name), sql);
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const MAIN = {
  '20261001000001_init.sql': `create table public.todos (id bigserial primary key, title text);
alter table public.todos enable row level security;
grant select on public.todos to anon;
grant select (title), update (title) on public.todos to authenticated;
grant insert on public.todos to public;
create policy "z read" on public.todos for select to anon, public using (true);
create policy "a own" on public.todos as restrictive for update to authenticated using (auth.uid() is not null) with check (false);
create table private.audit_log (id int);
create view public.open_todos as select * from public.todos;
alter table auth.users enable row level security;
this is not sql;
do $$ begin perform 1; end $$;`,
  '20261001000002_realtime.sql': `create publication zeta for table public.todos;
alter publication supabase_realtime add table public.todos, private.audit_log;
create publication alpha for tables in schema public, private;
do $$ begin execute format('alter publication %I add table public.todos', 'beta'); end $$;
create or replace function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
create table public.orders (id int);
alter publication zeta drop table public.todos;`,
};

describe('loading', () => {
  it('throws not-loaded before loadEngine() resolves, then replays', async () => {
    vi.resetModules();
    const fresh = await import('../../src/engine.js');
    expect(fresh.isEngineLoaded()).toBe(false);
    const dir = project(MAIN);
    let thrown: unknown;
    try {
      fresh.replayProjectSync({ projectDir: dir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(fresh.EngineError);
    expect(thrown).toMatchObject({ code: 'not-loaded', name: 'EngineError' });
    await fresh.loadEngine();
    await fresh.loadEngine();
    expect(fresh.isEngineLoaded()).toBe(true);
    expect(fresh.replayProjectSync({ projectDir: dir }).snapshotVersion).toBe(1);
  });

  it('replayProject loads the engine and equals replayProjectSync', async () => {
    const dir = project(MAIN);
    const viaAsync = await replayProject({ projectDir: dir });
    expect(isEngineLoaded()).toBe(true);
    expect(replayProjectSync({ projectDir: dir })).toEqual(viaAsync);
  });
});

describe('snapshot', () => {
  it('records relations, RLS, privileges and policies', async () => {
    await loadEngine();
    // Without the platform's default grants, so the privileges are the migrations' own.
    const snapshot = replayProjectSync({
      projectDir: project(MAIN),
      overrides: { platformDefaults: 'explicit' },
    });
    expect(snapshot.relations.map((r) => `${r.schema}.${r.name} ${r.kind}`)).toEqual([
      'public.todos table',
      'private.audit_log table',
      'public.open_todos view',
      'public.orders table',
    ]);
    const [todos, audit, , orders] = snapshot.relations;
    expect(todos).toEqual({
      schema: 'public',
      name: 'todos',
      kind: 'table',
      created: { file: 'supabase/migrations/20261001000001_init.sql', line: 1, column: 1 },
      rls: {
        enabled: true,
        forced: false,
        source: 'statement',
        at: { file: 'supabase/migrations/20261001000001_init.sql', line: 2, column: 1 },
      },
      privileges: {
        anon: { select: 'table' },
        authenticated: { select: 'columns', update: 'columns' },
        public: { insert: 'table' },
      },
      policies: [
        {
          name: 'a own',
          command: 'update',
          roles: ['authenticated'],
          permissive: false,
          using: 'other',
          withCheck: 'false',
          created: { file: 'supabase/migrations/20261001000001_init.sql', line: 7, column: 1 },
          altered: null,
        },
        {
          name: 'z read',
          command: 'select',
          roles: ['anon', 'public'],
          permissive: true,
          using: 'other',
          withCheck: null,
          created: { file: 'supabase/migrations/20261001000001_init.sql', line: 6, column: 1 },
          altered: null,
        },
      ],
    });
    expect(audit?.rls).toEqual({ enabled: false, forced: false, source: 'default', at: null });
    // The rls_auto_enable function was defined before `orders` (autoRls "auto").
    expect(orders?.rls).toEqual({
      enabled: true,
      forced: false,
      source: 'auto-rls',
      at: { file: 'supabase/migrations/20261001000002_realtime.sql', line: 5, column: 1 },
    });
  });

  it('records sequences with their owner and privileges', async () => {
    await loadEngine();
    const dir = project({
      '1_a.sql': `create table public.scores (id serial, n int);
create sequence public.counter;
grant usage, select on sequence public.counter to authenticated, public;`,
    });
    const snapshot = replayProjectSync({
      projectDir: dir,
      overrides: { platformDefaults: 'explicit' },
    });
    expect(snapshot.sequences).toEqual([
      {
        schema: 'public',
        name: 'scores_id_seq',
        privileges: {},
        ownedBy: { schema: 'public', name: 'scores', column: 'id' },
      },
      {
        schema: 'public',
        name: 'counter',
        privileges: { authenticated: ['select', 'usage'], public: ['select', 'usage'] },
        ownedBy: null,
      },
    ]);
  });

  it('records publications sorted by name, with the uncertain mark and exclusions', async () => {
    await loadEngine();
    const snapshot = replayProjectSync({ projectDir: project(MAIN) });
    const at = (line: number) => ({
      file: 'supabase/migrations/20261001000002_realtime.sql',
      line,
      column: 1,
    });
    expect(snapshot.publications).toEqual([
      {
        name: 'alpha',
        origin: 'migration',
        allTables: false,
        schemas: ['private', 'public'],
        tables: [],
        uncertain: at(4),
        excluded: [],
      },
      {
        name: 'supabase_realtime',
        origin: 'platform',
        allTables: false,
        schemas: [],
        tables: [
          { schema: 'private', name: 'audit_log' },
          { schema: 'public', name: 'todos' },
        ],
        uncertain: at(4),
        excluded: [],
      },
      {
        name: 'zeta',
        origin: 'migration',
        allTables: false,
        schemas: [],
        tables: [],
        uncertain: at(4),
        excluded: [{ schema: 'public', name: 'todos' }],
      },
    ]);
  });

  it('records meta: version, config source, counts, since and automatic RLS', async () => {
    await loadEngine();
    const snapshot = replayProjectSync({ projectDir: project(MAIN) });
    expect(snapshot.meta).toEqual({
      engineVersion: version,
      configSource: 'defaults',
      files: 2,
      since: { value: null, source: null },
      parseProblems: 1,
      dynamicSql: 2,
      declarativeFiles: 0,
      autoRls: {
        mode: 'auto',
        active: { file: 'supabase/migrations/20261001000002_realtime.sql', line: 5, column: 1 },
      },
      notes: [
        expect.objectContaining({
          at: { file: 'supabase/migrations/20261001000001_init.sql', line: 10, column: 1 },
        }),
      ],
    });
    expect(snapshot.meta.notes[0]?.message).toContain('auth.users');
  });

  it('counts declarative schema files without replaying them', async () => {
    await loadEngine();
    const dir = project(
      { '1_a.sql': 'create table public.todos (id int);' },
      { 'supabase/schemas/orders.sql': 'create table public.orders (id int);' },
    );
    const snapshot = replayProjectSync({ projectDir: dir });
    expect(snapshot.meta.declarativeFiles).toBe(1);
    expect(snapshot.relations.map((r) => r.name)).toEqual(['todos']);
  });

  it('is byte-identical across runs and project locations, with / in paths', async () => {
    await loadEngine();
    const dir = project(MAIN);
    const copy = path.join(temp, 'copy', 'nested');
    cpSync(dir, copy, { recursive: true });
    const json = JSON.stringify(replayProjectSync({ projectDir: dir }));
    expect(JSON.stringify(replayProjectSync({ projectDir: dir }))).toBe(json);
    expect(JSON.stringify(replayProjectSync({ projectDir: copy }))).toBe(json);
    expect(json).not.toContain('\\');
    expect(json).not.toContain(temp);
    expect(JSON.parse(json)).toEqual(replayProjectSync({ projectDir: dir }));
  });

  it('resolves since exactly as check does', async () => {
    await loadEngine();
    const dir = project({
      '20261001000001_a.sql': 'create table public.todos (id int);',
      '20261001000002_b.sql':
        'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;',
    });
    expect(replayProjectSync({ projectDir: dir }).meta.since).toEqual({
      value: '20261001000002',
      source: 'auto',
    });
    const loaded = await loadProject({ cwd: dir });
    expect(loaded.inputs.map((i) => i.file)).toEqual([
      'supabase/migrations/20261001000001_a.sql',
      'supabase/migrations/20261001000002_b.sql',
    ]);
  });
});

describe('config and overrides', () => {
  const sql = {
    '1_a.sql': `create or replace function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
create table public.todos (id int);`,
  };

  it('reads autoRls and platformPublications from grants-lint.config.json', async () => {
    await loadEngine();
    const dir = project(sql, {
      'grants-lint.config.json': JSON.stringify({ autoRls: 'off', platformPublications: [] }),
    });
    const snapshot = replayProjectSync({ projectDir: dir });
    expect(snapshot.meta.configSource).toBe('grants-lint.config.json');
    expect(snapshot.meta.autoRls).toEqual({ mode: 'off', active: null });
    expect(snapshot.relations[0]?.rls.source).toBe('default');
    expect(snapshot.publications).toEqual([]);
  });

  it('reads package.json#grantsLint and an explicit config file', async () => {
    await loadEngine();
    const dir = project(sql, {
      'package.json': JSON.stringify({ grantsLint: { autoRls: 'on' } }),
      'config/gl.json': JSON.stringify({ platformPublications: ['custom'] }),
    });
    const fromPackage = replayProjectSync({ projectDir: dir });
    expect(fromPackage.meta.configSource).toBe('package.json#grantsLint');
    expect(fromPackage.meta.autoRls).toEqual({ mode: 'on', active: 'start' });
    const explicit = replayProjectSync({ projectDir: dir, configFile: 'config/gl.json' });
    expect(explicit.meta.configSource).toBe('config/gl.json');
    expect(explicit.publications.map((p) => p.name)).toEqual(['custom']);
  });

  it('applies overrides above the config file', async () => {
    await loadEngine();
    const dir = project(sql, {
      'grants-lint.config.json': JSON.stringify({ autoRls: 'off' }),
    });
    const snapshot = replayProjectSync({
      projectDir: dir,
      overrides: { autoRls: 'on', since: '1', platformPublications: ['a', 'b'] },
    });
    expect(snapshot.meta.configSource).toBe('grants-lint.config.json');
    expect(snapshot.meta.autoRls.mode).toBe('on');
    expect(snapshot.meta.since).toEqual({ value: '1', source: 'config' });
    expect(snapshot.publications.map((p) => p.name)).toEqual(['a', 'b']);
  });
});

describe('errors', () => {
  const capture = (fn: () => unknown): EngineError => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      return error as EngineError;
    }
    throw new Error('expected an EngineError');
  };

  it('gives code config for a bad config file, keeping the issues', async () => {
    await loadEngine();
    const dir = project({ '1_a.sql': '' }, { 'grants-lint.config.json': '{"autoRls": "maybe"}' });
    const error = capture(() => replayProjectSync({ projectDir: dir }));
    expect(error.code).toBe('config');
    expect(error.message).toContain('grants-lint.config.json');
    expect(error.cause).toBeInstanceOf(ConfigError);
    expect((error.cause as ConfigError).issues[0]?.key).toBe('autoRls');
  });

  it('gives code config for a missing config file, a bad override or an unknown key', async () => {
    await loadEngine();
    const dir = project({ '1_a.sql': '' });
    expect(capture(() => replayProjectSync({ projectDir: dir, configFile: 'no.json' })).code).toBe(
      'config',
    );
    const bad = capture(() =>
      replayProjectSync({ projectDir: dir, overrides: { autoRls: 'maybe' as 'on' } }),
    );
    expect(bad.code).toBe('config');
    const unknown = capture(() =>
      listReplayInputs({ projectDir: dir, overrides: { rules: {} } as never }),
    );
    expect(unknown).toMatchObject({ code: 'config' });
    expect(unknown.message).toBe('Invalid config in overrides: "rules" cannot be overridden');
  });

  it('gives code project for a missing project or migrations directory', async () => {
    await loadEngine();
    const missing = capture(() => replayProjectSync({ projectDir: path.join(temp, 'none') }));
    expect(missing.code).toBe('project');
    expect(missing.message).toContain('Project directory not found');
    const empty = path.join(temp, 'empty');
    mkdirSync(empty);
    const noMigrations = capture(() => replayProjectSync({ projectDir: empty }));
    expect(noMigrations.code).toBe('project');
    expect(noMigrations.message).toContain('Migrations directory not found');
  });

  it('rethrows anything else unchanged', async () => {
    await loadEngine();
    const dir = project({ '1_a.sql': '' });
    const boom = new TypeError('boom');
    const overrides = {
      get since(): string {
        throw boom;
      },
    };
    expect(() => replayProjectSync({ projectDir: dir, overrides })).toThrow(boom);
  });
});

describe('listReplayInputs', () => {
  it('lists the files loadProject reads, the config file and the directories to watch', async () => {
    const dir = project(
      { '20261001000002_b.sql': '', '20261001000001_a.sql': '', 'seed.sql': '' },
      { 'package.json': JSON.stringify({ name: 'x', grantsLint: { autoRls: 'on' } }) },
    );
    const inputs = listReplayInputs({ projectDir: dir });
    const loaded = await loadProject({ cwd: dir });
    expect(inputs.migrations.map((m) => path.relative(dir, m).split(path.sep).join('/'))).toEqual(
      loaded.inputs.map((i) => i.file),
    );
    expect(inputs).toEqual({
      projectDir: dir,
      configFile: path.join(dir, 'package.json'),
      configSource: 'package.json#grantsLint',
      migrations: ['20261001000001_a.sql', '20261001000002_b.sql', 'seed.sql'].map((f) =>
        path.join(dir, 'supabase', 'migrations', f),
      ),
      watchDirs: [dir, path.join(dir, 'supabase', 'migrations')].sort(),
    });
  });

  it('gives null and defaults without a config, and the folder itself when it holds the SQL', () => {
    const dir = project({}, { '1_a.sql': '' }, '.');
    expect(listReplayInputs({ projectDir: dir })).toEqual({
      projectDir: dir,
      configFile: null,
      configSource: 'defaults',
      migrations: [path.join(dir, '1_a.sql')],
      watchDirs: [dir],
    });
  });

  it('watches a glob root, listed directories and the folders of listed files', () => {
    const dir = project(
      {},
      {
        'db/one/1_a.sql': '',
        'db/two/deep/2_b.sql': '',
        'extra/3_c.sql': '',
        'single/4_d.sql': '',
        'top.sql': '',
        'grants-lint.config.json': JSON.stringify({
          migrations: ['db/**/*.sql', 'extra', 'single\\4_d.sql', '*.sql'],
        }),
      },
      'supabase',
    );
    const inputs = listReplayInputs({ projectDir: dir });
    expect(inputs.configFile).toBe(path.join(dir, 'grants-lint.config.json'));
    expect(inputs.migrations).toHaveLength(5);
    expect(inputs.watchDirs).toEqual(
      [
        dir,
        path.join(dir, 'db'),
        path.join(dir, 'db', 'one'),
        path.join(dir, 'db', 'two', 'deep'),
        path.join(dir, 'extra'),
        path.join(dir, 'single'),
      ].sort(),
    );
  });
});
