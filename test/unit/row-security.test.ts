import { beforeAll, describe, expect, it } from 'vitest';
import type { AutoRlsMode } from '../../src/config/defaults.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import type { Statement, StatementKind } from '../../src/parse/ir.js';
import { type Catalog, isAutoRlsTrigger, type RowSecurity } from '../../src/model/relations.js';
import { type FileReplay, replay, type ReplayResult } from '../../src/replay/engine.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const FILE = 'supabase/migrations/20261001000001_m1.sql';

function one<K extends StatementKind>(sql: string, kind: K): Extract<Statement, { kind: K }> {
  const { statements } = parser.parse(sql, FILE);
  expect(statements).toHaveLength(1);
  const [statement] = statements;
  expect(statement?.kind).toBe(kind);
  return statement as Extract<Statement, { kind: K }>;
}

function path(n: number): string {
  return `supabase/migrations/2026100100000${String(n)}_m${String(n)}.sql`;
}

function run(sources: readonly string[], autoRls?: AutoRlsMode): ReplayResult {
  return replay(
    sources.map((sql, i) => ({
      file: path(i + 1),
      version: `2026100100000${String(i + 1)}`,
      statements: parser.parse(sql, path(i + 1)).statements,
    })),
    {
      schemas: ['public'],
      migrationRole: 'postgres',
      platformDefaults: 'legacy',
      ...(autoRls === undefined ? {} : { autoRls }),
    },
  );
}

function rls(catalog: Catalog, qualified: string): RowSecurity {
  const [schema = '', name = ''] = qualified.split('.');
  const relation = catalog.relation({ schema, name });
  if (relation === undefined) throw new Error(`${qualified} is not tracked`);
  return relation.rls;
}

/** The replay of file `n` (from 1). */
function fileOf(result: ReplayResult, n: number): FileReplay {
  const file = result.files[n - 1];
  if (file === undefined) throw new Error(`no file ${String(n)}`);
  return file;
}

const OFF: RowSecurity = { enabled: false, forced: false, source: 'default', at: null };

describe('parse: ALTER TABLE ... ROW LEVEL SECURITY', () => {
  it('maps each of the four subcommands', () => {
    expect(
      one('alter table todos enable row level security;', 'AlterTableRowSecurity'),
    ).toMatchObject({
      relation: { schema: null, name: 'todos' },
      ifExists: false,
      only: false,
      actions: ['enable'],
    });
    expect(
      one(
        'alter table public.todos disable row level security, no force row level security;',
        'AlterTableRowSecurity',
      ).actions,
    ).toEqual(['disable', 'no-force']);
  });

  it('keeps IF EXISTS, ONLY, quoted names and statement order, and ignores other subcommands', () => {
    expect(
      one(
        'alter table if exists only "Private"."My Todos" force row level security, add column x int, enable row level security;',
        'AlterTableRowSecurity',
      ),
    ).toMatchObject({
      relation: { schema: 'Private', name: 'My Todos' },
      ifExists: true,
      only: true,
      actions: ['force', 'enable'],
    });
  });

  it('leaves ALTER TABLE without a row security subcommand Unknown', () => {
    expect(one('alter table public.todos add column y int;', 'Unknown').nodeType).toBe(
      'AlterTableStmt',
    );
  });
});

describe('parse: event triggers', () => {
  it('maps CREATE EVENT TRIGGER with and without a tag filter', () => {
    expect(
      one(
        `create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();`,
        'EventTrigger',
      ),
    ).toMatchObject({
      action: 'create',
      name: 'ensure_rls',
      event: 'ddl_command_end',
      tags: ['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO'],
      function: { schema: 'public', name: 'rls_auto_enable' },
    });
    expect(
      one('create event trigger e on ddl_command_start execute procedure f();', 'EventTrigger'),
    ).toMatchObject({
      action: 'create',
      event: 'ddl_command_start',
      tags: null,
      function: { schema: null, name: 'f' },
    });
  });

  it('keeps only TAG filters (Postgres rejects any other filter variable when it runs)', () => {
    expect(
      one(
        `create event trigger e on ddl_command_end when tag in ('CREATE TABLE') and other in ('x') execute function f();`,
        'EventTrigger',
      ),
    ).toMatchObject({ tags: ['CREATE TABLE'] });
    expect(
      one(
        `create event trigger e on ddl_command_end when other in ('x') execute function f();`,
        'EventTrigger',
      ),
    ).toMatchObject({ tags: [] });
  });

  it.each([
    ['enable', 'O'],
    ['enable replica', 'R'],
    ['enable always', 'A'],
    ['disable', 'D'],
  ] as const)('maps ALTER EVENT TRIGGER ... %s', (sql, state) => {
    expect(one(`alter event trigger e ${sql};`, 'EventTrigger')).toMatchObject({
      action: 'enable',
      name: 'e',
      state,
    });
  });

  it('maps RENAME TO and DROP', () => {
    expect(one('alter event trigger e rename to f;', 'EventTrigger')).toMatchObject({
      action: 'rename',
      name: 'e',
      newName: 'f',
    });
    expect(one('drop event trigger if exists e, "G";', 'EventTrigger')).toMatchObject({
      action: 'drop',
      names: ['e', 'G'],
      ifExists: true,
    });
    expect(one('drop event trigger e;', 'EventTrigger')).toMatchObject({ ifExists: false });
  });
});

describe('parse: functions', () => {
  it('maps CREATE FUNCTION and records whether it returns event_trigger', () => {
    expect(
      one(
        'create or replace function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;',
        'FunctionDefinition',
      ),
    ).toMatchObject({
      name: { schema: 'public', name: 'rls_auto_enable' },
      returnsEventTrigger: true,
    });
    expect(
      one(
        'create function f(a int) returns setof int language sql as $$ select 1 $$;',
        'FunctionDefinition',
      ),
    ).toMatchObject({ name: { schema: null, name: 'f' }, returnsEventTrigger: false });
    expect(
      one('create procedure p() language sql as $$ select 1 $$;', 'FunctionDefinition')
        .returnsEventTrigger,
    ).toBe(false);
  });

  it.each(['function', 'procedure', 'routine'])('maps DROP %s', (type) => {
    expect(
      one(`drop ${type} if exists public.rls_auto_enable(), g cascade;`, 'DropFunctions'),
    ).toMatchObject({
      functions: [
        { schema: 'public', name: 'rls_auto_enable' },
        { schema: null, name: 'g' },
      ],
      ifExists: true,
      cascade: true,
    });
  });

  it('defaults DROP FUNCTION to no IF EXISTS and RESTRICT', () => {
    expect(one('drop function f(int);', 'DropFunctions')).toMatchObject({
      functions: [{ schema: null, name: 'f' }],
      ifExists: false,
      cascade: false,
    });
  });
});

describe('replay: row level security', () => {
  it('starts off at CREATE TABLE', () => {
    expect(rls(run(['create table public.todos (id int);']).final, 'public.todos')).toEqual(OFF);
  });

  it('applies ENABLE, FORCE, NO FORCE and DISABLE in order, with the location', () => {
    const result = run([
      'create table public.todos (id int);\nalter table todos enable row level security, force row level security;',
      'alter table public.todos no force row level security;',
      'alter table public.todos disable row level security, enable row level security, disable row level security;',
    ]);
    expect(rls(fileOf(result, 1).after, 'public.todos')).toEqual({
      enabled: true,
      forced: true,
      source: 'statement',
      at: { file: path(1), line: 2, column: 1 },
    });
    expect(rls(fileOf(result, 2).after, 'public.todos')).toMatchObject({
      enabled: true,
      forced: false,
    });
    expect(rls(fileOf(result, 3).after, 'public.todos')).toEqual({
      enabled: false,
      forced: false,
      source: 'statement',
      at: { file: path(3), line: 1, column: 1 },
    });
  });

  it('keeps the source when only FORCE changes', () => {
    const result = run([
      'create table public.todos (id int);',
      'alter table public.todos force row level security;',
    ]);
    expect(rls(result.final, 'public.todos')).toEqual({ ...OFF, forced: true });
  });

  it('carries the state through RENAME and SET SCHEMA, and removes it on DROP', () => {
    const result = run([
      'create table public.todos (id int); alter table public.todos enable row level security;',
      'alter table public.todos rename to tasks; alter table public.tasks set schema private;',
      'drop table private.tasks; create table private.tasks (id int);',
    ]);
    expect(rls(fileOf(result, 2).after, 'private.tasks')).toMatchObject({
      enabled: true,
      source: 'statement',
    });
    expect(rls(fileOf(result, 3).after, 'private.tasks')).toEqual(OFF);
  });

  it('records a note, and no state, for a relation the migrations do not create', () => {
    const result = run([
      'alter table auth.users enable row level security;\nalter table if exists public.gone disable row level security;',
    ]);
    expect(result.final.relations()).toEqual([]);
    expect(result.final.notes()).toEqual([
      {
        code: 'rls-untracked-relation',
        message:
          'Row level security of auth.users is not modelled: the migrations do not create it.',
        at: { file: path(1), line: 1, column: 1 },
      },
      {
        code: 'rls-untracked-relation',
        message:
          'Row level security of public.gone is not modelled: the migrations do not create it.',
        at: { file: path(1), line: 2, column: 1 },
      },
    ]);
  });

  it('records no replay events', () => {
    const result = run([
      'create table public.todos (id int);',
      `alter table public.todos enable row level security;
       alter table public.missing enable row level security;
       create function public.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;
       create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();
       alter event trigger ensure_rls disable;
       alter event trigger ensure_rls rename to ensure_rls_2;
       drop event trigger ensure_rls_2;
       drop function public.rls_auto_enable();`,
    ]);
    expect(fileOf(result, 2).events).toEqual([]);
  });
});

const AUTO_RLS_FUNCTION = `create or replace function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$ begin end $$;`;
const ENSURE_RLS = `create event trigger ensure_rls on ddl_command_end when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();`;

describe('replay: automatic RLS (ensure_rls)', () => {
  it('turns RLS on for later tables in public while an enabled trigger exists', () => {
    const result = run([
      'create table public.before (id int);',
      `${ENSURE_RLS}
       create table public.todos (id int);
       create table public.parted (id int) partition by range (id);
       create table public.part1 partition of public.parted for values from (0) to (10);
       create table public.copy as select 1 as id;
       create view public.v as select 1;
       create table private.other (id int);`,
    ]);
    const trigger = { file: path(2), line: 1, column: 1 };
    const auto = { enabled: true, forced: false, source: 'auto-rls', at: trigger };
    for (const table of ['public.todos', 'public.parted', 'public.part1', 'public.copy']) {
      expect(rls(result.final, table)).toEqual(auto);
    }
    for (const relation of ['public.before', 'public.v', 'private.other']) {
      expect(rls(result.final, relation)).toEqual(OFF);
    }
    expect(result.final.autoRls()).toEqual(trigger);
    expect(fileOf(result, 1).after.autoRls()).toBeNull();
  });

  it('lets a later explicit DISABLE win', () => {
    const result = run([
      `${ENSURE_RLS} create table public.todos (id int);`,
      'alter table public.todos disable row level security;',
    ]);
    expect(rls(result.final, 'public.todos')).toMatchObject({
      enabled: false,
      source: 'statement',
    });
  });

  it.each([
    ['disabled', `${ENSURE_RLS} alter event trigger ensure_rls disable;`],
    ['enabled for replicas only', `${ENSURE_RLS} alter event trigger ensure_rls enable replica;`],
    ['dropped', `${ENSURE_RLS} drop event trigger ensure_rls;`],
    ['dropped with its function', `${ENSURE_RLS} drop function public.rls_auto_enable() cascade;`],
    [
      'filtered to other tags',
      `create event trigger ensure_rls on ddl_command_end when tag in ('ALTER TABLE') execute function public.rls_auto_enable();`,
    ],
    [
      'on another event',
      `create event trigger ensure_rls on ddl_command_start execute function public.rls_auto_enable();`,
    ],
    [
      'neither named ensure_rls nor calling rls_auto_enable',
      `create event trigger audit on ddl_command_end execute function public.audit();`,
    ],
  ])('does nothing when the trigger is %s', (_, sql) => {
    const result = run([`${sql}\ncreate table public.todos (id int);`]);
    expect(rls(result.final, 'public.todos')).toEqual(OFF);
    expect(result.final.autoRls()).toBeNull();
  });

  it.each([
    [
      're-enabled with ALWAYS',
      `${ENSURE_RLS} alter event trigger ensure_rls disable; alter event trigger ensure_rls enable always;`,
    ],
    [
      'renamed (it still calls rls_auto_enable)',
      `${ENSURE_RLS} alter event trigger ensure_rls rename to keep_rls;`,
    ],
    [
      'unfiltered, named ensure_rls, calling another function',
      'create event trigger ensure_rls on ddl_command_end execute function private.enable_rls();',
    ],
    [
      'filtered with a lowercase tag',
      `create event trigger rls on ddl_command_end when tag in ('create table') execute procedure rls_auto_enable();`,
    ],
  ])('applies when the trigger is %s', (_, sql) => {
    const result = run([`${sql}\ncreate table public.todos (id int);`]);
    expect(rls(result.final, 'public.todos')).toMatchObject({ enabled: true, source: 'auto-rls' });
  });

  it('keeps the first trigger of a name, and ignores renames onto a taken name or of a missing one', () => {
    const result = run([
      `create event trigger ensure_rls on ddl_command_start execute function f();
       create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();
       create event trigger other on ddl_command_end execute function g();
       alter event trigger other rename to ensure_rls;
       alter event trigger missing rename to x;
       alter event trigger missing disable;
       create table public.todos (id int);`,
    ]);
    expect(result.final.eventTriggers().map((t) => [t.name, t.event])).toEqual([
      ['ensure_rls', 'ddl_command_start'],
      ['other', 'ddl_command_end'],
    ]);
    expect(rls(result.final, 'public.todos')).toEqual(OFF);
  });

  it('renames a trigger onto a free name', () => {
    const result = run([
      `create event trigger audit on ddl_command_end execute function public.rls_auto_enable();
       alter event trigger audit rename to rls_guard;`,
    ]);
    expect(result.final.eventTriggers().map((t) => t.name)).toEqual(['rls_guard']);
    expect(result.final.eventTrigger('audit')).toBeUndefined();
  });
});

describe('replay: autoRls modes', () => {
  it('"auto" (the default) counts the rls_auto_enable function a pulled baseline keeps', () => {
    const result = run([
      'create table public.before (id int);',
      `${AUTO_RLS_FUNCTION}\n${AUTO_RLS_FUNCTION}\ncreate table public.todos (id int);`,
      'drop function if exists public.rls_auto_enable(); create table public.after (id int);',
    ]);
    const fn = { file: path(2), line: 1, column: 1 };
    expect(rls(result.final, 'public.before')).toEqual(OFF);
    expect(rls(result.final, 'public.todos')).toEqual({
      enabled: true,
      forced: false,
      source: 'auto-rls',
      at: fn,
    });
    expect(rls(result.final, 'public.after')).toEqual(OFF);
    expect(fileOf(result, 2).after.autoRls()).toEqual(fn);
    expect(result.final.autoRls()).toBeNull();
  });

  it('prefers an enabled trigger over the function as the activation', () => {
    const result = run([
      `${AUTO_RLS_FUNCTION}\n${ENSURE_RLS}\ncreate table public.todos (id int);`,
    ]);
    expect(rls(result.final, 'public.todos').at).toEqual({ file: path(1), line: 2, column: 1 });
  });

  it.each([
    [
      'returning another type',
      'create function public.rls_auto_enable() returns void language sql as $$ select $$;',
    ],
    [
      'in another schema',
      'create function private.rls_auto_enable() returns event_trigger language plpgsql as $$ begin end $$;',
    ],
    [
      'with another name',
      'create function public.auto_rls() returns event_trigger language plpgsql as $$ begin end $$;',
    ],
  ])('ignores a function %s', (_, sql) => {
    const result = run([`${sql}\ncreate table public.todos (id int);`]);
    expect(rls(result.final, 'public.todos')).toEqual(OFF);
  });

  it('"off" ignores the trigger and the function', () => {
    const result = run(
      [`${AUTO_RLS_FUNCTION}\n${ENSURE_RLS}\ncreate table public.todos (id int);`],
      'off',
    );
    expect(rls(result.final, 'public.todos')).toEqual(OFF);
    expect(result.final.autoRls()).toBeNull();
    expect(result.final.autoRlsMode).toBe('off');
  });

  it('"on" applies from the start, located nowhere', () => {
    const result = run(
      ['create table public.todos (id int); create table private.x (id int);'],
      'on',
    );
    expect(rls(result.final, 'public.todos')).toEqual({
      enabled: true,
      forced: false,
      source: 'auto-rls',
      at: null,
    });
    expect(rls(result.final, 'private.x')).toEqual(OFF);
    expect(result.initial.autoRls()).toBe('start');
  });

  it('drops only the triggers of the dropped function on CASCADE', () => {
    const result = run([
      `${ENSURE_RLS}
       create event trigger audit on ddl_command_end execute function public.audit();
       drop function public.audit() cascade;
       drop function public.rls_auto_enable();`,
    ]);
    expect(result.final.eventTriggers().map((t) => t.name)).toEqual(['ensure_rls']);
  });

  it('keeps the triggers of a same-named function in another schema on CASCADE', () => {
    const result = run([
      `create event trigger audit on ddl_command_end execute function public.audit();
       drop function private.audit() cascade;`,
    ]);
    expect(result.final.eventTriggers().map((t) => t.name)).toEqual(['audit']);
  });

  it('keeps the rls_auto_enable fingerprint when another function is dropped', () => {
    const result = run([
      `${AUTO_RLS_FUNCTION}
       create function public.audit() returns void language sql as $$ select $$;
       drop function public.audit();
       create table public.todos (id int);`,
    ]);
    expect(rls(result.final, 'public.todos').source).toBe('auto-rls');
    expect(result.final.autoRls()).not.toBeNull();
  });
});

describe('isAutoRlsTrigger', () => {
  const base = {
    name: 'ensure_rls',
    event: 'ddl_command_end',
    tags: null,
    function: { schema: 'public', name: 'rls_auto_enable' },
    state: 'O',
    created: { file: FILE, line: 1, column: 1 },
  } as const;

  it.each([
    [{}, true],
    [{ state: 'A' }, true],
    [{ state: 'R' }, false],
    [{ state: 'D' }, false],
    [{ name: 'x' }, true],
    [{ name: 'x', function: { schema: 'public', name: 'f' } }, false],
    [{ function: { schema: 'public', name: 'f' } }, true],
    [{ event: 'sql_drop' }, false],
    [{ tags: ['CREATE TABLE AS'] }, false],
    [{ tags: ['SELECT INTO', 'Create Table'] }, true],
  ] as const)('%j -> %s', (change, expected) => {
    expect(isAutoRlsTrigger({ ...base, ...change })).toBe(expected);
  });
});
