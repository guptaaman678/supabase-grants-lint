import { beforeAll, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import {
  codePointToByteOffset,
  dynamicSqlMentions,
  LineIndex,
  loadParser,
  type MigrationParser,
  type ParsedFile,
} from '../../src/parse/adapter.js';
import type { Statement, StatementKind } from '../../src/parse/ir.js';
import { scanSuppressions, suppressionError } from '../../src/parse/suppressions.js';

const FILE = 'supabase/migrations/20261002120000_add_todos.sql';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

function parse(sql: string): ParsedFile {
  return parser.parse(sql, FILE);
}

/** The single statement of `sql`, checked to be of `kind`. */
function one<K extends StatementKind>(sql: string, kind: K): Extract<Statement, { kind: K }> {
  const { statements } = parse(sql);
  expect(statements).toHaveLength(1);
  const [statement] = statements;
  expect(statement?.kind).toBe(kind);
  return statement as Extract<Statement, { kind: K }>;
}

function kinds(sql: string): string[] {
  return parse(sql).statements.map((s) => s.kind);
}

describe('loadParser', () => {
  it('returns a working parser when called more than once', async () => {
    const again = await loadParser();
    expect(again.parse('select 1;', FILE).statements).toHaveLength(1);
  });

  it('returns no statements for empty, whitespace-only and comment-only files', () => {
    expect(parse('').statements).toEqual([]);
    expect(parse('  \n\n').statements).toEqual([]);
    expect(parse('-- nothing here\n/* or here */\n').statements).toEqual([]);
    expect(parse(';;').statements).toEqual([]);
  });
});

describe('CREATE of relations', () => {
  it('maps a plain CREATE TABLE with a schema-qualified name', () => {
    const s = one('create table public.todos (id uuid primary key, title text);', 'CreateRelation');
    expect(s).toMatchObject({
      relation: { schema: 'public', name: 'todos' },
      relationKind: 'table',
      temporary: false,
      ifNotExists: false,
      orReplace: false,
      partitionOf: null,
      serialColumns: [],
    });
  });

  it('keeps a bare name unqualified', () => {
    const s = one('create table todos (id int);', 'CreateRelation');
    expect(s.relation).toEqual({ schema: null, name: 'todos' });
  });

  it('keeps the case of quoted identifiers and lowercases unquoted ones', () => {
    expect(one('create table "Public"."Todos" (id int);', 'CreateRelation').relation).toEqual({
      schema: 'Public',
      name: 'Todos',
    });
    expect(one('create table PUBLIC.Todos (id int);', 'CreateRelation').relation).toEqual({
      schema: 'public',
      name: 'todos',
    });
  });

  it('records IF NOT EXISTS', () => {
    expect(
      one('create table if not exists public.todos (id int);', 'CreateRelation').ifNotExists,
    ).toBe(true);
  });

  it.each(['temp', 'temporary', 'local temp'])('marks CREATE %s TABLE as temporary', (word) => {
    expect(one(`create ${word} table scratch (id int);`, 'CreateRelation').temporary).toBe(true);
  });

  it('does not mark an unlogged table as temporary', () => {
    expect(
      one('create unlogged table public.audit_log (id int);', 'CreateRelation').temporary,
    ).toBe(false);
  });

  it('records serial columns of every spelling, and nothing for identity or uuid keys', () => {
    const s = one(
      `create table public.orders (
        id bigserial primary key,
        a smallserial, b serial, c serial2, d serial4, e serial8,
        f bigint generated always as identity,
        g uuid default gen_random_uuid(),
        h int
      );`,
      'CreateRelation',
    );
    expect(s.serialColumns).toEqual([
      { column: 'id', type: 'bigserial' },
      { column: 'a', type: 'smallserial' },
      { column: 'b', type: 'serial' },
      { column: 'c', type: 'serial2' },
      { column: 'd', type: 'serial4' },
      { column: 'e', type: 'serial8' },
    ]);
  });

  it('does not treat a column named serial, a qualified type or an array as a serial column', () => {
    const s = one(
      'create table public.orders (serial text, a pg_catalog.int8, b int[], c "serial" );',
      'CreateRelation',
    );
    expect(s.serialColumns).toEqual([{ column: 'c', type: 'serial' }]);
  });

  it('maps PARTITION OF with its parent', () => {
    const s = one(
      'create table public.messages_2026 partition of public.messages for values from (1) to (100);',
      'CreateRelation',
    );
    expect(s).toMatchObject({
      relation: { schema: 'public', name: 'messages_2026' },
      relationKind: 'table',
      partitionOf: { schema: 'public', name: 'messages' },
    });
  });

  it('does not treat INHERITS as PARTITION OF', () => {
    const s = one('create table public.b (x int) inherits (public.a);', 'CreateRelation');
    expect(s.partitionOf).toBeNull();
  });

  it('maps CREATE TABLE AS', () => {
    const s = one(
      'create table if not exists public.todos_copy as select 1 as x;',
      'CreateRelation',
    );
    expect(s).toMatchObject({
      relation: { schema: 'public', name: 'todos_copy' },
      relationKind: 'table',
      ifNotExists: true,
    });
  });

  it('maps CREATE TEMP TABLE AS as temporary', () => {
    expect(one('create temp table scratch as select 1;', 'CreateRelation').temporary).toBe(true);
  });

  it('maps views, OR REPLACE and temporary views', () => {
    expect(one('create view public.todo_titles as select 1;', 'CreateRelation')).toMatchObject({
      relationKind: 'view',
      orReplace: false,
      temporary: false,
    });
    expect(
      one(
        'create or replace view public.todo_titles with (security_invoker = on) as select 1;',
        'CreateRelation',
      ),
    ).toMatchObject({ relationKind: 'view', orReplace: true });
    expect(one('create temp view v as select 1;', 'CreateRelation').temporary).toBe(true);
  });

  it('maps materialized views', () => {
    const s = one(
      'create materialized view if not exists public.order_totals as select 1 with no data;',
      'CreateRelation',
    );
    expect(s).toMatchObject({
      relation: { schema: 'public', name: 'order_totals' },
      relationKind: 'materialized view',
      ifNotExists: true,
    });
  });

  it('maps foreign tables', () => {
    const s = one(
      'create foreign table if not exists public.remote_orders (id int) server archive;',
      'CreateRelation',
    );
    expect(s).toMatchObject({
      relation: { schema: 'public', name: 'remote_orders' },
      relationKind: 'foreign table',
      ifNotExists: true,
    });
  });
});

describe('CREATE SEQUENCE', () => {
  it('maps a sequence', () => {
    expect(
      one('create sequence if not exists public.order_numbers;', 'CreateSequence'),
    ).toMatchObject({
      sequence: { schema: 'public', name: 'order_numbers' },
      ifNotExists: true,
      temporary: false,
    });
    expect(one('create temp sequence s;', 'CreateSequence').temporary).toBe(true);
  });
});

describe('RENAME and SET SCHEMA', () => {
  it.each([
    ['alter table public.todos rename to tasks;', 'table'],
    ['alter view public.v rename to w;', 'view'],
    ['alter materialized view public.v rename to w;', 'materialized view'],
    ['alter foreign table public.v rename to w;', 'foreign table'],
    ['alter sequence public.v rename to w;', 'sequence'],
  ])('%s', (sql, objectKind) => {
    const s = one(sql, 'RenameObject');
    expect(s.objectKind).toBe(objectKind);
    expect(s.object.schema).toBe('public');
    expect(s.newName).toBe(sql.includes('todos') ? 'tasks' : 'w');
    expect(s.ifExists).toBe(false);
  });

  it('records IF EXISTS and ONLY on a rename', () => {
    const s = one('alter table if exists only public.todos rename to tasks;', 'RenameObject');
    expect(s).toMatchObject({ object: { schema: 'public', name: 'todos' }, ifExists: true });
  });

  it('keeps a quoted new name verbatim', () => {
    expect(one('alter table todos rename to "Tasks";', 'RenameObject').newName).toBe('Tasks');
  });

  it('leaves column renames Unknown', () => {
    const s = one('alter table public.todos rename column title to name;', 'Unknown');
    expect(s).toMatchObject({ nodeType: 'RenameStmt', detail: 'object type OBJECT_COLUMN' });
  });

  it.each([
    ['alter table public.todos set schema private;', 'table', 'private'],
    ['alter table if exists private.todos set schema public;', 'table', 'public'],
    ['alter view v set schema public;', 'view', 'public'],
    ['alter materialized view v set schema public;', 'materialized view', 'public'],
    ['alter foreign table v set schema public;', 'foreign table', 'public'],
    ['alter sequence s set schema public;', 'sequence', 'public'],
  ])('%s', (sql, objectKind, newSchema) => {
    const s = one(sql, 'SetSchema');
    expect(s.objectKind).toBe(objectKind);
    expect(s.newSchema).toBe(newSchema);
    expect(s.ifExists).toBe(sql.includes('if exists'));
  });

  it('leaves SET SCHEMA of a function Unknown', () => {
    expect(one('alter function f() set schema private;', 'Unknown').nodeType).toBe(
      'AlterObjectSchemaStmt',
    );
  });
});

describe('DROP', () => {
  it('maps a list with IF EXISTS and CASCADE', () => {
    const s = one('drop table if exists public.todos, orders cascade;', 'DropObjects');
    expect(s).toMatchObject({
      objectKind: 'table',
      objects: [
        { schema: 'public', name: 'todos' },
        { schema: null, name: 'orders' },
      ],
      ifExists: true,
      cascade: true,
    });
  });

  it.each([
    ['drop view public.v;', 'view'],
    ['drop materialized view public.v;', 'materialized view'],
    ['drop foreign table public.v;', 'foreign table'],
    ['drop sequence public.v restrict;', 'sequence'],
  ])('%s', (sql, objectKind) => {
    const s = one(sql, 'DropObjects');
    expect(s).toMatchObject({ objectKind, ifExists: false, cascade: false });
    expect(s.objects).toEqual([{ schema: 'public', name: 'v' }]);
  });

  it('maps DROP FUNCTION to DropFunctions and leaves DROP INDEX Unknown', () => {
    expect(kinds('drop function f(); drop index i;')).toEqual(['DropFunctions', 'Unknown']);
  });
});

describe('GRANT and REVOKE', () => {
  it('maps a multi-relation GRANT to several roles', () => {
    const s = one(
      'grant select, insert on table public.todos, orders to anon, "authenticated", public;',
      'Grant',
    );
    expect(s).toMatchObject({
      action: 'grant',
      objectKind: 'table',
      target: {
        kind: 'objects',
        objects: [
          { schema: 'public', name: 'todos' },
          { schema: null, name: 'orders' },
        ],
      },
      privileges: [
        { name: 'select', columns: null },
        { name: 'insert', columns: null },
      ],
      grantees: [
        { kind: 'role', name: 'anon' },
        { kind: 'role', name: 'authenticated' },
        { kind: 'public' },
      ],
      grantOption: false,
    });
  });

  it.each(['all', 'all privileges'])('maps GRANT %s to the privilege "all"', (words) => {
    const s = one(`grant ${words} on public.todos to service_role;`, 'Grant');
    expect(s.privileges).toEqual([{ name: 'all', columns: null }]);
  });

  it('maps column-level grants', () => {
    const s = one('grant update (title, done), select on public.todos to authenticated;', 'Grant');
    expect(s.privileges).toEqual([
      { name: 'update', columns: ['title', 'done'] },
      { name: 'select', columns: null },
    ]);
  });

  it('maps ALL (columns)', () => {
    const s = one('grant all (title) on public.todos to authenticated;', 'Grant');
    expect(s.privileges).toEqual([{ name: 'all', columns: ['title'] }]);
  });

  it('maps MAINTAIN', () => {
    expect(one('grant maintain on public.todos to authenticated;', 'Grant').privileges).toEqual([
      { name: 'maintain', columns: null },
    ]);
  });

  it('accepts WITH GRANT OPTION and GRANTED BY', () => {
    const s = one(
      'grant select on public.todos to anon with grant option granted by postgres;',
      'Grant',
    );
    expect(s).toMatchObject({
      action: 'grant',
      grantOption: true,
      grantees: [{ kind: 'role', name: 'anon' }],
    });
  });

  it('maps REVOKE and REVOKE GRANT OPTION FOR with CASCADE', () => {
    expect(one('revoke all on public.todos from anon, authenticated;', 'Grant')).toMatchObject({
      action: 'revoke',
      grantOption: false,
    });
    expect(
      one('revoke grant option for select on public.todos from authenticated cascade;', 'Grant'),
    ).toMatchObject({ action: 'revoke', grantOption: true, privileges: [{ name: 'select' }] });
  });

  it('maps ALL TABLES IN SCHEMA', () => {
    const s = one('grant select on all tables in schema public, private to anon;', 'Grant');
    expect(s).toMatchObject({
      objectKind: 'table',
      target: { kind: 'allInSchema', schemas: ['public', 'private'] },
    });
  });

  it('maps sequence grants and ALL SEQUENCES IN SCHEMA', () => {
    expect(
      one('grant usage, select on sequence public.orders_id_seq to anon;', 'Grant'),
    ).toMatchObject({
      objectKind: 'sequence',
      target: { kind: 'objects', objects: [{ schema: 'public', name: 'orders_id_seq' }] },
      privileges: [{ name: 'usage' }, { name: 'select' }],
    });
    expect(
      one('revoke all on all sequences in schema public from anon restrict;', 'Grant'),
    ).toMatchObject({
      action: 'revoke',
      objectKind: 'sequence',
      target: { kind: 'allInSchema', schemas: ['public'] },
      privileges: [{ name: 'all', columns: null }],
    });
  });

  it('maps CURRENT_USER, CURRENT_ROLE and SESSION_USER grantees', () => {
    const s = one('grant select on t to current_user, current_role, session_user;', 'Grant');
    expect(s.grantees).toEqual([
      { kind: 'current_user' },
      { kind: 'current_role' },
      { kind: 'session_user' },
    ]);
  });

  it.each([
    ['grant execute on function public.f() to anon;', 'object type OBJECT_FUNCTION'],
    ['grant usage on schema public to anon;', 'object type OBJECT_SCHEMA'],
    ['grant execute on all functions in schema public to anon;', 'object type OBJECT_FUNCTION'],
  ])('leaves %s Unknown', (sql, detail) => {
    expect(one(sql, 'Unknown')).toMatchObject({ nodeType: 'GrantStmt', detail });
  });

  it('leaves role membership grants Unknown', () => {
    expect(one('grant authenticated to postgres;', 'Unknown').nodeType).toBe('GrantRoleStmt');
  });
});

describe('ALTER DEFAULT PRIVILEGES', () => {
  it('maps FOR ROLE and IN SCHEMA lists', () => {
    const s = one(
      'alter default privileges for role postgres, "Owner" in schema public, private grant all on tables to anon, authenticated, service_role;',
      'AlterDefaultPrivileges',
    );
    expect(s).toMatchObject({
      action: 'grant',
      forRoles: [
        { kind: 'role', name: 'postgres' },
        { kind: 'role', name: 'Owner' },
      ],
      inSchemas: ['public', 'private'],
      objectKind: 'table',
      privileges: [{ name: 'all', columns: null }],
      grantees: [
        { kind: 'role', name: 'anon' },
        { kind: 'role', name: 'authenticated' },
        { kind: 'role', name: 'service_role' },
      ],
      grantOption: false,
    });
  });

  it('uses null for an omitted FOR ROLE and IN SCHEMA', () => {
    const s = one(
      'alter default privileges revoke usage, select on sequences from anon;',
      'AlterDefaultPrivileges',
    );
    expect(s).toMatchObject({
      action: 'revoke',
      forRoles: null,
      inSchemas: null,
      objectKind: 'sequence',
    });
  });

  it('accepts FOR USER and REVOKE GRANT OPTION FOR', () => {
    const s = one(
      'alter default privileges for user postgres revoke grant option for select on tables from anon cascade;',
      'AlterDefaultPrivileges',
    );
    expect(s).toMatchObject({ forRoles: [{ kind: 'role', name: 'postgres' }], grantOption: true });
  });

  it.each(['functions', 'routines', 'types', 'schemas'])(
    'leaves defaults ON %s Unknown',
    (kind) => {
      const grantee = kind === 'schemas' ? 'usage' : kind === 'types' ? 'usage' : 'execute';
      const sql = `alter default privileges grant ${grantee} on ${kind} to anon;`;
      expect(one(sql, 'Unknown').nodeType).toBe('AlterDefaultPrivilegesStmt');
    },
  );
});

// Plain test titles: Stryker selects tests by a name pattern, and SQL punctuation in a title
// (quotes, parentheses, `*`, and in practice commas and hyphens) stops it from matching, which
// reports killed mutants as surviving.
describe('service role only policy expressions for ADR 012', () => {
  const using = (expr: string): unknown =>
    one(`create policy p on todos using (${expr});`, 'CreatePolicy').using;

  const SERVICE_ROLE_ONLY = [
    "auth.role() = 'service_role'",
    "'service_role' = auth.role()",
    "(auth.role()) = ('service_role')",
    "auth.role() = 'service_role'::text",
    "auth.role()::text = 'service_role'::pg_catalog.text",
    "(select auth.role()) = 'service_role'",
    "(select auth.role()) = 'service_role'::text",
    "auth.jwt() ->> 'role' = 'service_role'",
    "(auth.jwt() ->> 'role'::text) = 'service_role'",
    "(select auth.jwt() ->> 'role') = 'service_role'",
    "((select auth.jwt()) ->> 'role') = 'service_role'",
    "current_setting('request.jwt.claim.role') = 'service_role'",
    "current_setting('request.jwt.claim.role', true) = 'service_role'",
    "current_setting('request.jwt.claim.role'::text, true)::text = 'service_role'",
    "current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role'",
    "current_setting('request.jwt.claims')::pg_catalog.jsonb ->> 'role' = 'service_role'",
    "current_user = 'service_role'",
    "current_role = 'service_role'",
    "session_user = 'service_role'",
    "'service_role' = current_user",
  ];

  const OTHER = [
    "auth.role() = 'authenticated'",
    "'authenticated' = auth.role()",
    "auth.role() <> 'service_role'",
    "auth.role() is distinct from 'service_role'",
    "auth.role() is not distinct from 'service_role'",
    "operator(=) 'service_role'",
    "(->> 'role') = 'service_role'",
    "(select) = 'service_role'",
    "auth.role() operator(pg_catalog.=) 'service_role'",
    "auth.role() = 'service_role' or auth.uid() = user_id",
    "auth.role() = 'service_role' and auth.uid() = user_id",
    'auth.uid() = user_id',
    'is_admin()',
    'true',
    "auth.role('x') = 'service_role'",
    "auth.jwt('x') ->> 'role' = 'service_role'",
    "role() = 'service_role'",
    "other.role() = 'service_role'",
    "auth.role() = 'service_role'::varchar",
    "auth.role()::text[] = 'service_role'",
    "auth.role()::public.text = 'service_role'",
    "auth.role()::a.b.text = 'service_role'",
    "auth.role()::pg_catalog.a.text = 'service_role'",
    "(select auth.role() from todos) = 'service_role'",
    "(select auth.role() where true) = 'service_role'",
    "(select auth.role(), 1) = 'service_role'",
    "(select *) = 'service_role'",
    "exists (select auth.role()) = 'service_role'",
    "auth.jwt() ->> 'sub' = 'service_role'",
    "auth.jwt() -> 'role' = 'service_role'",
    "auth.jwt() ->> 'role' = 'anon'",
    "current_setting('request.jwt.claim.sub') = 'service_role'",
    "current_setting('request.jwt.claim.role', true, 1) = 'service_role'",
    "current_setting('request.jwt.claims', true)::json ->> 'role' = 'service_role'",
    "current_setting('request.jwt.claims', true) ->> 'role' = 'service_role'",
    "current_setting('request.jwt.claim.role', true)::jsonb ->> 'role' = 'service_role'",
    "current_setting('request.jwt.claims', true)::jsonb[] ->> 'role' = 'service_role'",
    "user_id = 'service_role'",
    "current_date = 'service_role'",
    'current_user = user_id',
    "'service_role' = 'service_role'",
    "1 = 'service_role'",
  ];

  it('classifies each recognised request role test as service_role', () => {
    for (const expr of SERVICE_ROLE_ONLY) expect(using(expr), expr).toBe('service_role');
  });

  it('classifies every other expression as other', () => {
    for (const expr of OTHER) expect(using(expr), expr).toBe('other');
  });

  it('classifies the constant false, bare or cast to bool, as false (ADR-019)', () => {
    for (const expr of [
      'false',
      'FALSE',
      'false::boolean',
      'false::bool',
      'cast(false as boolean)',
    ]) {
      expect(using(expr), expr).toBe('false');
    }
    for (const expr of [
      "'f'",
      "'false'::boolean",
      'not true',
      'false or auth.uid() = user_id',
      'false and true',
      'false::text',
      'false::boolean[]',
      'false::public.bool',
      'null',
      '1 = 0',
    ]) {
      expect(using(expr), expr).toBe('other');
    }
  });

  it('classifies USING and WITH CHECK separately and reports absent ones as null', () => {
    expect(
      one(
        "create policy p on todos for insert with check (auth.role() = 'service_role');",
        'CreatePolicy',
      ),
    ).toMatchObject({ using: null, withCheck: 'service_role' });
    expect(
      one(
        "create policy p on todos using (auth.role() = 'service_role') with check (true);",
        'CreatePolicy',
      ),
    ).toMatchObject({ using: 'service_role', withCheck: 'other' });
  });

  it('reports what ALTER POLICY changes and null for what it leaves alone', () => {
    expect(one('alter policy p on todos to anon;', 'AlterPolicy')).toMatchObject({
      using: null,
      withCheck: null,
    });
    expect(
      one(
        "alter policy p on todos using (auth.uid() = user_id) with check (auth.role() = 'service_role');",
        'AlterPolicy',
      ),
    ).toMatchObject({ using: 'other', withCheck: 'service_role' });
  });
});

describe('policies', () => {
  it('maps CREATE POLICY with every clause', () => {
    const s = one(
      'create policy "own rows" on public.todos as permissive for select to authenticated, anon using (auth.uid() = user_id);',
      'CreatePolicy',
    );
    expect(s).toMatchObject({
      name: 'own rows',
      relation: { schema: 'public', name: 'todos' },
      command: 'select',
      roles: [
        { kind: 'role', name: 'authenticated' },
        { kind: 'role', name: 'anon' },
      ],
      permissive: true,
    });
  });

  it('defaults the command to all and the roles to PUBLIC', () => {
    const s = one('create policy p on todos using (true);', 'CreatePolicy');
    expect(s).toMatchObject({
      command: 'all',
      roles: [{ kind: 'public' }],
      relation: { schema: null },
    });
  });

  it.each(['insert', 'update', 'delete', 'all'])('maps FOR %s', (command) => {
    const check = command === 'insert' ? 'with check (true)' : 'using (true)';
    const s = one(`create policy p on todos for ${command} to anon ${check};`, 'CreatePolicy');
    expect(s.command).toBe(command);
  });

  it('maps restrictive policies and TO public', () => {
    const s = one(
      'create policy p on todos as restrictive to public using (true);',
      'CreatePolicy',
    );
    expect(s).toMatchObject({ permissive: false, roles: [{ kind: 'public' }] });
  });

  it('maps ALTER POLICY with and without TO', () => {
    expect(
      one('alter policy p on public.todos to anon, authenticated;', 'AlterPolicy'),
    ).toMatchObject({
      name: 'p',
      relation: { schema: 'public', name: 'todos' },
      roles: [
        { kind: 'role', name: 'anon' },
        { kind: 'role', name: 'authenticated' },
      ],
    });
    expect(one('alter policy p on public.todos using (false);', 'AlterPolicy').roles).toBeNull();
  });

  it('maps a policy rename', () => {
    expect(one('alter policy p on public.todos rename to q;', 'RenamePolicy')).toMatchObject({
      name: 'p',
      relation: { schema: 'public', name: 'todos' },
      newName: 'q',
    });
  });

  it('maps DROP POLICY with a qualified and a bare table', () => {
    expect(one('drop policy if exists "own rows" on public.todos;', 'DropPolicy')).toMatchObject({
      name: 'own rows',
      relation: { schema: 'public', name: 'todos' },
      ifExists: true,
    });
    expect(one('drop policy p on todos;', 'DropPolicy')).toMatchObject({
      relation: { schema: null, name: 'todos' },
      ifExists: false,
    });
  });
});

describe('SET ROLE', () => {
  it.each([
    ['set role postgres;', 'postgres', false],
    ['set role "Owner";', 'Owner', false],
    ["set role 'postgres';", 'postgres', false],
    ['set local role postgres;', 'postgres', true],
    ['set session role postgres;', 'postgres', false],
    ['reset role;', null, false],
    ['set role none;', null, false],
    ['set role to default;', null, false],
    ['set role = default;', null, false],
  ])('%s', (sql, role, local) => {
    expect(one(sql, 'SetRole')).toMatchObject({ role, local });
  });

  it('rejects `set role default` without TO, as Postgres does', () => {
    expect(one('set role default;', 'Unparseable').message).toMatch(/syntax error/);
  });

  it('leaves other settings Unknown', () => {
    expect(one('set search_path = public;', 'Unknown')).toMatchObject({
      nodeType: 'VariableSetStmt',
      detail: 'setting search_path',
    });
    expect(one('reset all;', 'Unknown').nodeType).toBe('VariableSetStmt');
  });
});

describe('DO blocks', () => {
  it('maps a DO block with the keywords its body mentions', () => {
    const s = one(
      "do $$ begin execute 'grant select on public.todos to anon'; execute 'create policy p on t using (true)'; end $$;",
      'DynamicSql',
    );
    expect(s.language).toBeNull();
    expect(s.body).toContain('grant select on public.todos');
    expect(s.mentions).toEqual(['grant', 'create policy']);
  });

  it('maps a tagged body and a LANGUAGE clause', () => {
    const s = one("do language plpgsql $body$ begin raise notice 'a;b'; end $body$;", 'DynamicSql');
    expect(s).toMatchObject({ language: 'plpgsql', mentions: [] });
    expect(s.body).toContain("raise notice 'a;b'");
  });

  it.each([
    ['GRANT select', ['grant']],
    ['revoke all', ['revoke']],
    ['create table x', ['create table']],
    ['CREATE  UNLOGGED\n TABLE x', ['create table']],
    ['create temp table x', ['create table']],
    ['create policy p', ['create policy']],
    ['alter default\tprivileges', ['default privileges']],
    ['granted, revoked, create tables, policy', []],
    ['perform 1', []],
  ])('dynamicSqlMentions(%j)', (body, expected) => {
    expect(dynamicSqlMentions(body)).toEqual(expected);
  });
});

describe('Unknown', () => {
  it('maps valid statements the model does not need, and never throws', () => {
    const sql = `
      begin;
      select 1;
      insert into public.todos (title) values ('x');
      create index on public.todos (title);
      comment on table public.todos is 'grant all; create table public.x (id int)';
      create trigger t before insert on public.todos for each row execute function public.f();
      alter table public.todos add column done boolean;
      alter table public.todos owner to postgres;
      create extension if not exists pgcrypto;
      commit;
    `;
    const statements = parse(sql).statements;
    expect(statements.map((s) => s.kind)).toEqual(Array(10).fill('Unknown'));
    expect(statements.map((s) => (s.kind === 'Unknown' ? s.nodeType : ''))).toEqual([
      'TransactionStmt',
      'SelectStmt',
      'InsertStmt',
      'IndexStmt',
      'CommentStmt',
      'CreateTrigStmt',
      'AlterTableStmt',
      'AlterTableStmt',
      'CreateExtensionStmt',
      'TransactionStmt',
    ]);
  });
});

describe('locations', () => {
  it('reports the line and column of each statement, skipping leading comments', () => {
    const sql = [
      '-- header comment',
      '/* a block',
      '   comment */',
      'create table public.todos (id int);',
      '',
      '  grant select on public.todos to anon;   -- trailing',
      'grant insert',
      '  on public.todos',
      '  to authenticated;',
    ].join('\n');
    const at = parse(sql).statements.map((s) => [s.file, s.line, s.column, s.text]);
    expect(at).toEqual([
      [FILE, 4, 1, 'create table public.todos (id int)'],
      [FILE, 6, 3, 'grant select on public.todos to anon'],
      [FILE, 7, 1, 'grant insert\n  on public.todos\n  to authenticated'],
    ]);
  });

  it('converts byte offsets when non-ASCII text comes first', () => {
    const sql = [
      '-- Überblick: tâches, 注文, emoji 🎉',
      "comment on table public.todos is 'déjà vu 🎉';",
      "select 'ü', 1; grant select on public.todos to anon;",
    ].join('\n');
    const statements = parse(sql).statements;
    expect(statements.map((s) => [s.line, s.column])).toEqual([
      [2, 1],
      [3, 1],
      [3, 16],
    ]);
    expect(statements[2]?.text).toBe('grant select on public.todos to anon');
    expect(statements[1]?.text).toBe("select 'ü', 1");
  });

  it('handles CRLF line endings and a byte order mark', () => {
    const sql = '\uFEFFselect 1;\r\n\r\n  grant select on public.todos to anon;\r\n';
    expect(parse(sql).statements.map((s) => [s.line, s.column, s.text])).toEqual([
      [1, 1, 'select 1'],
      [3, 3, 'grant select on public.todos to anon'],
    ]);
  });

  it('gives the last statement without a semicolon its full text', () => {
    const statements = parse('select 1;\ngrant select on public.todos to anon\n').statements;
    expect(statements[1]?.text).toBe('grant select on public.todos to anon');
  });
});

describe('recovery from syntax errors (PARSE001)', () => {
  const sql = [
    'create table public.orders (id bigserial primary key);',
    'grant selectt oon public.orders to anon;',
    "do $$ begin perform 1; execute 'grant select on public.orders to anon'; end $$;",
    '-- comment before the last statement',
    'grant select on public.orders to authenticated;',
  ].join('\n');

  it('skips only the bad statement and keeps the rest of the file', () => {
    expect(kinds(sql)).toEqual(['CreateRelation', 'Unparseable', 'DynamicSql', 'Grant']);
  });

  it('locates the bad statement and names the error position', () => {
    const bad = parse(sql).statements[1];
    expect(bad).toMatchObject({
      kind: 'Unparseable',
      file: FILE,
      line: 2,
      column: 1,
      text: 'grant selectt oon public.orders to anon',
    });
    expect(bad?.kind === 'Unparseable' && bad.message).toBe(
      'syntax error at or near "oon" (line 2, column 15)',
    );
  });

  it('keeps locations of statements after the bad one', () => {
    const statements = parse(sql).statements;
    expect(statements.map((s) => s.line)).toEqual([1, 2, 3, 5]);
    expect(statements[3]?.text).toBe('grant select on public.orders to authenticated');
  });

  it('points the error at the right column after non-ASCII text', () => {
    const bad = parse("select 'é'; grant é oon t;").statements[1];
    expect(bad?.kind === 'Unparseable' && bad.message).toBe(
      'syntax error at or near "oon" (line 1, column 21)',
    );
  });

  it('reports several bad statements in one file', () => {
    expect(kinds('grant x;\nselect 1;\ncreate tabel t ();\n')).toEqual([
      'Unparseable',
      'Unknown',
      'Unparseable',
    ]);
  });

  it('reports an unterminated literal as one unparseable statement at the error', () => {
    const statements = parse(
      "select 1;\nselect 'never closed;\ngrant select on t to anon;",
    ).statements;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ kind: 'Unparseable', line: 2, column: 8 });
    expect(statements[0]?.kind === 'Unparseable' && statements[0].message).toContain(
      'unterminated quoted string',
    );
  });
});

describe('LineIndex and codePointToByteOffset', () => {
  it('maps offsets to lines and columns', () => {
    const index = new LineIndex(Buffer.from('ab\ncé\n\nx'));
    expect(index.position(0)).toEqual({ line: 1, column: 1 });
    expect(index.position(2)).toEqual({ line: 1, column: 3 });
    expect(index.position(3)).toEqual({ line: 2, column: 1 });
    expect(index.position(6)).toEqual({ line: 2, column: 3 });
    expect(index.position(7)).toEqual({ line: 3, column: 1 });
    expect(index.position(8)).toEqual({ line: 4, column: 1 });
    expect(index.lineOf(100)).toBe(4);
  });

  it('counts code points, not UTF-16 units, for the parser error cursor', () => {
    expect(codePointToByteOffset('a🎉b', 0)).toBe(0);
    expect(codePointToByteOffset('a🎉b', 1)).toBe(1);
    expect(codePointToByteOffset('a🎉b', 2)).toBe(5);
    expect(codePointToByteOffset('é', 5)).toBe(2);
  });
});

describe('suppressions', () => {
  it('reads a disable-next-line comment with a reason', () => {
    const { suppressions, suppressionProblems } = parse(
      [
        'create table public.audit_log (id int);',
        '-- grants-lint-disable-next-line GL002: written by a trigger only',
        'create policy p on public.audit_log for select to authenticated using (true);',
      ].join('\n'),
    );
    expect(suppressionProblems).toEqual([]);
    expect(suppressions).toEqual([
      {
        file: FILE,
        line: 2,
        column: 1,
        rules: ['GL002'],
        reason: 'written by a trigger only',
        targetLine: 3,
      },
    ]);
  });

  it('accepts several rules, lowercase IDs, trailing comments and block comments', () => {
    const { suppressions, suppressionProblems } = parse(
      [
        'select 1; -- grants-lint-disable-next-line gl002, GL003 GL003: legacy table',
        'select 2;',
        '/* grants-lint-disable-next-line GL008: needs',
        '   truncate for the nightly job */',
        'select 3;',
      ].join('\n'),
    );
    expect(suppressionProblems).toEqual([]);
    expect(suppressions.map((s) => [s.line, s.column, s.rules, s.reason, s.targetLine])).toEqual([
      [1, 11, ['GL002', 'GL003'], 'legacy table', 2],
      [3, 1, ['GL008'], 'needs\n   truncate for the nightly job', 5],
    ]);
  });

  it('ignores the directive inside string literals and dollar-quoted bodies', () => {
    const { suppressions, suppressionProblems } = parse(
      [
        "comment on table public.todos is '-- grants-lint-disable-next-line GL001: no';",
        'do $$ begin -- grants-lint-disable-next-line GL001',
        'perform 1; end $$;',
      ].join('\n'),
    );
    expect(suppressions).toEqual([]);
    expect(suppressionProblems).toEqual([]);
  });

  it('ignores comments that only look like the directive', () => {
    const { suppressions, suppressionProblems } = parse(
      '-- grants-lint-disable-next-lines GL001: x\n-- see grants-lint-disable-next-line GL001\n',
    );
    expect(suppressions).toEqual([]);
    expect(suppressionProblems).toEqual([]);
  });

  it.each([
    ['-- grants-lint-disable-next-line GL002', 'GL002 needs a reason after a colon'],
    ['-- grants-lint-disable-next-line GL002:   ', 'GL002 needs a reason after a colon'],
    ['-- grants-lint-disable-next-line: because', 'must name the rule it disables'],
    ['-- grants-lint-disable-next-line', 'must name the rule it disables'],
    ['-- grants-lint-disable-next-line GL02: x', 'Unknown rule "GL02" (did you mean GL002?)'],
    ['-- grants-lint-disable-next-line nope: x', 'Unknown rule "nope"'],
  ])('reports %j', (comment, message) => {
    const { suppressions, suppressionProblems } = parse(`select 1;\n${comment}\nselect 2;`);
    expect(suppressions).toEqual([]);
    expect(suppressionProblems).toHaveLength(1);
    expect(suppressionProblems[0]).toMatchObject({ file: FILE, line: 2, column: 1 });
    expect(suppressionProblems[0]?.message).toContain(message);
    expect(suppressionProblems[0]?.message).toContain(
      'Expected: -- grants-lint-disable-next-line GL002: <reason>',
    );
  });

  it('still finds whole-line comments when the scanner cannot read the file', () => {
    const { statements, suppressions } = parse(
      "-- grants-lint-disable-next-line GL001: kept\nselect 'never closed;\n",
    );
    expect(statements.map((s) => s.kind)).toEqual(['Unparseable']);
    expect(suppressions.map((s) => [s.line, s.rules, s.targetLine])).toEqual([[1, ['GL001'], 2]]);
  });

  it('turns problems into one usage error (exit 2) naming file, line and column', () => {
    const { problems } = scanSuppressions([
      {
        file: 'a.sql',
        line: 3,
        column: 5,
        endLine: 3,
        text: '-- grants-lint-disable-next-line GL001',
      },
    ]);
    const error = suppressionError(problems);
    expect(error.exitCode).toBe(ExitCode.Usage);
    expect(error.message).toMatch(/^Invalid suppression comment at a\.sql:3:5: /);

    const two = suppressionError([...problems, ...problems]);
    expect(two.message.split('\n')).toHaveLength(3);
    expect(two.message).toMatch(/^Invalid suppression comments:\n {2}- a\.sql:3:5: /);
  });
});
