/**
 * Declarative schemas (T11.2, ADR-017): the config.toml reader, discovery in the order the
 * Supabase CLI applies the files, the Prisma directory version, and how `lint` checks the files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../../src/errors.js';
import { isDeclarativeEnforced, lint } from '../../src/lint.js';
import { compareUtf8, discoverSchemaFiles } from '../../src/load/declarative.js';
import { discoverMigrations, migrationVersion } from '../../src/load/discover.js';
import { autoExposeSetting, readSupabaseToml } from '../../src/load/supabase-config.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'grants-lint-declarative-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relPath: string, text = '-- test\n'): void {
  const abs = path.join(root, ...relPath.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function discover(schemaPaths: 'auto' | string[] = 'auto') {
  const found = discoverSchemaFiles({ schemaPaths, projectDir: root, cwd: root });
  return { source: found.source, files: found.files.map((f) => f.relPath) };
}

const OPT_IN =
  'alter default privileges for role postgres in schema public\n' +
  '  revoke all on tables from anon, authenticated, service_role;\n';

describe('readSupabaseToml', () => {
  it('reads tables, dotted keys, booleans, strings and multi-line string arrays', () => {
    const toml = [
      'project_id = "demo" # a comment',
      '[api]',
      'auto_expose_new_tables = false',
      '[db.migrations]',
      'enabled = true',
      'schema_paths = [',
      '  "./schemas/a#b.sql", # hash inside a string is kept',
      "  './schemas/*.sql',",
      ']',
      '[experimental."pgdelta"]',
      'declarative_schema_path = "declared"',
      'port = 54322',
      'mixed = ["a", 1]',
    ].join('\n');
    const values = readSupabaseToml(toml);
    expect(values.get('project_id')).toBe('demo');
    expect(values.get('api.auto_expose_new_tables')).toBe(false);
    expect(values.get('db.migrations.enabled')).toBe(true);
    expect(values.get('db.migrations.schema_paths')).toEqual([
      './schemas/a#b.sql',
      './schemas/*.sql',
    ]);
    expect(values.get('experimental.pgdelta.declarative_schema_path')).toBe('declared');
    expect(values.has('db.migrations.port')).toBe(false);
    expect(values.has('experimental.pgdelta.port')).toBe(false);
    expect(values.has('experimental.pgdelta.mixed')).toBe(false);
  });

  it('reads a one-line array, an empty array and escapes in basic strings', () => {
    const values = readSupabaseToml(
      '[db.migrations]\nschema_paths = ["a.sql", "b\\"c.sql"]\nother = []\n',
    );
    expect(values.get('db.migrations.schema_paths')).toEqual(['a.sql', 'b"c.sql']);
    expect(values.get('db.migrations.other')).toEqual([]);
  });

  it('keeps autoExposeSetting to booleans', () => {
    expect(autoExposeSetting('[api]\nauto_expose_new_tables = true\n')).toBe(true);
    expect(autoExposeSetting('[api]\nauto_expose_new_tables = "false"\n')).toBeNull();
    expect(autoExposeSetting('')).toBeNull();
  });
});

describe('discoverSchemaFiles', () => {
  it('finds nothing without declarative schemas', () => {
    write('supabase/migrations/1_a.sql');
    expect(discover()).toEqual({ source: null, files: [] });
  });

  it('walks supabase/schemas recursively in byte order of the paths, .sql files only', () => {
    // Distinct names only: macOS disks are case-insensitive.
    write('supabase/schemas/b.sql');
    write('supabase/schemas/C.sql');
    write('supabase/schemas/a_b.sql');
    write('supabase/schemas/a/b.sql');
    write('supabase/schemas/notes.md');
    expect(discover()).toEqual({
      source: 'default',
      files: [
        'supabase/schemas/C.sql',
        'supabase/schemas/a/b.sql',
        'supabase/schemas/a_b.sql',
        'supabase/schemas/b.sql',
      ],
    });
  });

  it('follows config.toml schema_paths: entries in order, matches sorted, duplicates skipped', () => {
    write('supabase/schemas/a.sql');
    write('supabase/schemas/b.sql');
    write('supabase/schemas/z.sql');
    write('supabase/other/c.sql');
    write(
      'supabase/config.toml',
      '[db.migrations]\nschema_paths = ["./schemas/z.sql", "./schemas/*.sql", "other"]\n',
    );
    expect(discover()).toEqual({
      source: 'config.toml',
      files: [
        'supabase/schemas/z.sql',
        'supabase/schemas/a.sql',
        'supabase/schemas/b.sql',
        'supabase/other/c.sql',
      ],
    });
  });

  it('skips a schema_paths glob whose directory is missing, but not a missing literal path', () => {
    write('supabase/schemas/a.sql');
    write('supabase/config.toml', '[db.migrations]\nschema_paths = ["nope/*.sql", "schemas"]\n');
    expect(discover().files).toEqual(['supabase/schemas/a.sql']);
    write('supabase/config.toml', '[db.migrations]\nschema_paths = ["schemas/missing.sql"]\n');
    const error = (() => {
      try {
        discover();
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('schemas/missing.sql');
  });

  it('uses the pg-delta declarative directory when pg-delta is enabled', () => {
    write('supabase/schemas/ignored.sql');
    write('supabase/declared/a.sql');
    write(
      'supabase/config.toml',
      '[experimental.pgdelta]\nenabled = true\ndeclarative_schema_path = "declared"\n',
    );
    expect(discover()).toEqual({ source: 'pgdelta', files: ['supabase/declared/a.sql'] });
  });

  it('falls back to supabase/schemas when the pg-delta directory is missing or disabled', () => {
    write('supabase/schemas/a.sql');
    write('supabase/declared/b.sql');
    write(
      'supabase/config.toml',
      '[experimental.pgdelta]\nenabled = true\ndeclarative_schema_path = "missing"\n',
    );
    expect(discover()).toEqual({ source: 'default', files: ['supabase/schemas/a.sql'] });
    write(
      'supabase/config.toml',
      '[experimental.pgdelta]\nenabled = false\ndeclarative_schema_path = "declared"\n',
    );
    expect(discover().source).toBe('default');
  });

  it('pg-delta defaults to supabase/schemas', () => {
    write('supabase/schemas/a.sql');
    write('supabase/config.toml', '[experimental.pgdelta]\nenabled = true\n');
    expect(discover()).toEqual({ source: 'pgdelta', files: ['supabase/schemas/a.sql'] });
  });

  it('an empty schema_paths falls through to the next source', () => {
    write('supabase/schemas/a.sql');
    write('supabase/config.toml', '[db.migrations]\nschema_paths = []\n');
    expect(discover().source).toBe('default');
  });

  it('a config list replaces the ladder, relative to the project; [] turns discovery off', () => {
    write('supabase/schemas/a.sql');
    write('db/schema/b.sql');
    write('db/schema/a.sql');
    expect(discover(['db/schema'])).toEqual({
      source: 'config',
      files: ['db/schema/a.sql', 'db/schema/b.sql'],
    });
    expect(discover([])).toEqual({ source: null, files: [] });
  });

  it('compares by UTF-8 bytes, not UTF-16 code units', () => {
    // In UTF-16, U+1F600 (a surrogate pair from 0xD83D) sorts before U+FF5E; in UTF-8 it is after.
    expect(compareUtf8('\u{1F600}', '\u{FF5E}')).toBeGreaterThan(0);
    expect(compareUtf8('\u{FF5E}', '\u{1F600}')).toBeLessThan(0);
    expect(compareUtf8('a', 'a')).toBe(0);
  });
});

describe('migrationVersion', () => {
  it('reads the version from the file name, else from its directory (Prisma)', () => {
    expect(migrationVersion('/p/supabase/migrations/20261001_a.sql')).toBe('20261001');
    expect(migrationVersion('/p/prisma/migrations/20261002_add/migration.sql')).toBe('20261002');
    expect(migrationVersion('/p/supabase/migrations/seed.sql')).toBeNull();
  });

  it('orders Prisma migrations by directory and reports no version notice', () => {
    write('prisma/migrations/20261002000000_b/migration.sql');
    write('prisma/migrations/20261001000000_a/migration.sql');
    const found = discoverMigrations({
      cwd: root,
      migrations: 'prisma/migrations/*/migration.sql',
    });
    expect(found.files.map((f) => [f.relPath, f.version])).toEqual([
      ['prisma/migrations/20261001000000_a/migration.sql', '20261001000000'],
      ['prisma/migrations/20261002000000_b/migration.sql', '20261002000000'],
    ]);
    expect(found.notices).toEqual([]);
  });

  it('a missing default migrations folder is only allowed when asked', () => {
    expect(() => discoverMigrations({ cwd: root })).toThrow(UsageError);
    expect(discoverMigrations({ cwd: root, allowMissingDefault: true }).files).toEqual([]);
    expect(() =>
      discoverMigrations({ cwd: root, migrations: 'db', allowMissingDefault: true }),
    ).toThrow(UsageError);
  });
});

describe('lint with declarative schemas', () => {
  const TABLE = 'create table public.todos (id uuid primary key, owner uuid);\n';
  const POLICY = 'create policy "own" on public.todos for select to authenticated using (true);\n';

  async function run() {
    const result = await lint({ cwd: root });
    return {
      findings: result.findings.map(
        (f) => `${f.ruleId} ${f.file}:${String(f.line)} ${f.role ?? ''}`,
      ),
      notices: result.notices.map((n) => n.code),
      summary: result.summary,
      since: result.since.value,
    };
  }

  it('does not check declarative files until the project is opted in, and says so once', async () => {
    write('supabase/migrations/20260901000000_init.sql', 'create table public.old (id int);\n');
    write('supabase/schemas/todos.sql', TABLE + POLICY);
    write('supabase/schemas/views.sql', 'create view public.v as select 1;\n');
    const { findings, notices, since, summary } = await run();
    expect(since).toBeNull();
    expect(findings).toEqual(['GL000 supabase/migrations/20260901000000_init.sql:1 ']);
    expect(notices).toEqual(['declarative-not-checked']);
    expect(summary.files).toBe(1);
    expect(summary.relations).toBe(1);
    expect(summary.notices).toBe(1);
    const notice = (await lint({ cwd: root })).notices[0];
    expect(notice).toEqual({
      code: 'declarative-not-checked',
      message: expect.stringMatching(
        /^2 declarative schema files were not checked: .*They are/,
      ) as unknown,
      file: 'supabase/schemas/todos.sql',
      line: 1,
      column: 1,
    });
  });

  it('checks every declarative relation from no default grants once since resolves', async () => {
    write('supabase/migrations/20260901000000_init.sql', 'create table public.old (id int);\n');
    write('supabase/schemas/todos.sql', TABLE + POLICY);
    write('grants-lint.config.json', JSON.stringify({ since: '20260901000000' }));
    const { findings, notices, since, summary } = await run();
    expect(since).toBe('20260901000000');
    expect(findings).toEqual([
      'GL001 supabase/schemas/todos.sql:1 service_role',
      'GL002 supabase/schemas/todos.sql:1 authenticated',
    ]);
    expect(notices).toEqual([]);
    expect(summary.files).toBe(2);
    expect(summary.relations).toBe(2);
  });

  it('auto_expose_new_tables = false in supabase/config.toml opts the schema files in', async () => {
    write('supabase/schemas/todos.sql', TABLE + POLICY);
    write('supabase/config.toml', '[api]\nauto_expose_new_tables = false\n');
    expect((await run()).findings).toEqual([
      'GL001 supabase/schemas/todos.sql:1 service_role',
      'GL002 supabase/schemas/todos.sql:1 authenticated',
    ]);
    write('supabase/config.toml', '[api]\nauto_expose_new_tables = true\n');
    expect(await run()).toMatchObject({ findings: [], notices: ['declarative-not-checked'] });
  });

  it('isDeclarativeEnforced: a resolved since, or auto_expose_new_tables = false', () => {
    const since = (value: string | null) => ({ value, source: null, detected: null });
    expect(isDeclarativeEnforced(since(null), root)).toBe(false);
    expect(isDeclarativeEnforced(since('none'), root)).toBe(true);
    expect(isDeclarativeEnforced(since('20261001'), root)).toBe(true);
    write('supabase/config.toml', '[api]\n');
    expect(isDeclarativeEnforced(since(null), root)).toBe(false);
    write('supabase/config.toml', '[api]\nauto_expose_new_tables = false\n');
    expect(isDeclarativeEnforced(since(null), root)).toBe(true);
  });

  it('unchecked schema files keep their suppressions and ignore entries quiet', async () => {
    write(
      'supabase/schemas/todos.sql',
      '-- grants-lint-disable-next-line GL001: server code never reads todos\n' + TABLE,
    );
    write(
      'grants-lint.config.json',
      JSON.stringify({ ignore: [{ rule: 'GL002', relation: 'todos', reason: 'checked by hand' }] }),
    );
    expect((await run()).notices).toEqual(['declarative-not-checked']);
  });

  it('a default-privilege re-grant in a schema file is GL006, not GL007', async () => {
    write('supabase/migrations/20261001000000_opt_in.sql', OPT_IN);
    write(
      'supabase/schemas/a.sql',
      'alter default privileges in schema public grant all on tables to anon;\n' + TABLE,
    );
    const { findings } = await run();
    expect(findings.filter((f) => /GL00[67]/.test(f))).toEqual(['GL006 supabase/schemas/a.sql:1 ']);
  });

  it('a grant in another schema file counts; GL003 is dropped when GL002 fires across files', async () => {
    write('supabase/migrations/20261001000000_opt_in.sql', OPT_IN);
    write('supabase/schemas/a_tables.sql', TABLE);
    write('supabase/schemas/b_policies.sql', POLICY);
    expect((await run()).findings).toEqual([
      'GL001 supabase/schemas/a_tables.sql:1 service_role',
      'GL002 supabase/schemas/a_tables.sql:1 authenticated',
    ]);
    write(
      'supabase/schemas/c_grants.sql',
      'grant select on public.todos to authenticated, service_role;\n',
    );
    expect((await run()).findings).toEqual([]);
  });

  it('inline suppressions and ignore entries apply to schema files', async () => {
    write('supabase/migrations/20261001000000_opt_in.sql', OPT_IN);
    write(
      'supabase/schemas/todos.sql',
      '-- grants-lint-disable-next-line GL001: server code never reads todos\n' +
        TABLE +
        'grant select on public.todos to authenticated;\n',
    );
    write(
      'grants-lint.config.json',
      JSON.stringify({
        ignore: [{ rule: 'GL008', relation: 'public.todos', reason: 'checked by hand' }],
      }),
    );
    const { findings, notices } = await run();
    expect(findings).toEqual([]);
    // The ignore entry matched nothing in either the migrations or the schema files.
    expect(notices).toEqual(['unused-ignore']);
  });

  it('an ignore entry used only by a schema file is not reported unused', async () => {
    write('supabase/migrations/20261001000000_opt_in.sql', OPT_IN);
    write('supabase/schemas/todos.sql', TABLE);
    write(
      'grants-lint.config.json',
      JSON.stringify({ ignore: [{ rule: 'GL001', relation: 'todos', reason: 'server never' }] }),
    );
    const { findings, notices } = await run();
    expect(findings).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('schemaPaths [] skips the schema files', async () => {
    write('supabase/migrations/20261001000000_opt_in.sql', OPT_IN);
    write('supabase/schemas/todos.sql', TABLE);
    write('grants-lint.config.json', JSON.stringify({ schemaPaths: [] }));
    const { findings, summary } = await run();
    expect(findings).toEqual([]);
    expect(summary.files).toBe(1);
  });

  it('reports migrations first, then schema files in the order they apply', async () => {
    write('supabase/migrations/20261001000000_opt_in.sql', OPT_IN);
    write('supabase/migrations/20261002000000_todos.sql', TABLE);
    write('supabase/schemas/todos.sql', TABLE);
    const { findings, summary } = await run();
    expect(findings).toEqual([
      'GL001 supabase/migrations/20261002000000_todos.sql:1 service_role',
      'GL001 supabase/schemas/todos.sql:1 service_role',
    ]);
    // The same table in both counts once.
    expect(summary.relations).toBe(1);
  });

  it('rejects a bad schemaPaths value', async () => {
    write('supabase/schemas/todos.sql', TABLE);
    write('grants-lint.config.json', JSON.stringify({ schemaPaths: 'supabase/schemas' }));
    await expect(lint({ cwd: root })).rejects.toThrow(/schemaPaths/);
  });
});
