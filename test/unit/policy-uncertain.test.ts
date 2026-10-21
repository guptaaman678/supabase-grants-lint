/**
 * Policies changed inside `DO` blocks or by unparseable policy statements (engine only): the
 * parser's scan of the body or statement, the replay's uncertain mark on the named relations, and
 * the snapshot field that carries it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadParser,
  type MigrationParser,
  policyMentions,
  unparseablePolicyMentions,
} from '../../src/parse/adapter.js';
import { Catalog } from '../../src/model/relations.js';
import { replay, type ReplayResult } from '../../src/replay/engine.js';
import { toSnapshot } from '../../src/snapshot.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

function path(n: number): string {
  return `supabase/migrations/2026100100000${String(n)}_m${String(n)}.sql`;
}

function run(sources: readonly string[]): ReplayResult {
  return replay(
    sources.map((sql, i) => ({
      file: path(i + 1),
      version: `2026100100000${String(i + 1)}`,
      statements: parser.parse(sql, path(i + 1)).statements,
    })),
    { schemas: ['public'], migrationRole: 'postgres', platformDefaults: 'legacy' },
  );
}

function at(file: number, line: number, column = 1) {
  return { file: path(file), line, column };
}

function mark(result: ReplayResult, name: string, schema = 'public') {
  const found = result.final.policiesUncertain({ schema, name });
  return found === null ? null : { file: found.file, line: found.line, column: found.column };
}

const TABLES = `create table public.todos (id int);
create table public.orders (id int);
create table private.audit_log (id int);`;

const GUARDED = `do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'todos_select') then
    create policy todos_select on public.todos for select to authenticated using (true);
  end if;
end $$;`;

describe('policyMentions', () => {
  it.each([
    [
      'create policy p on public.todos for select using (true)',
      [{ schema: 'public', name: 'todos' }],
    ],
    ['create policy p on todos using (true)', [{ schema: null, name: 'todos' }]],
    ['CREATE POLICY P ON Public.Todos USING (true)', [{ schema: 'public', name: 'todos' }]],
    ['create policy "p" on "Pub"."My ""T"""', [{ schema: 'Pub', name: 'My "T"' }]],
    ['create policy "read on all" on public.orders', [{ schema: 'public', name: 'orders' }]],
    ['drop policy if exists p on public.orders;', [{ schema: 'public', name: 'orders' }]],
    ['DROP POLICY IF EXISTS "p" ON orders', [{ schema: null, name: 'orders' }]],
    ['create policy if not exists p on public.todos', [{ schema: 'public', name: 'todos' }]],
    ['alter policy p on public.todos rename to q', [{ schema: 'public', name: 'todos' }]],
    [
      'alter policy p\n  on public.todos\n  to authenticated',
      [{ schema: 'public', name: 'todos' }],
    ],
    ["execute 'create policy p on public.todos for select'", [{ schema: 'public', name: 'todos' }]],
    [
      "execute format('create policy %I on public.todos', 'p')",
      [{ schema: 'public', name: 'todos' }],
    ],
  ])('reads %j', (body, expected) => {
    expect(policyMentions(body)).toEqual(expected);
  });

  it.each([
    "execute format('create policy %I on %I.%I using (true)', 'p', 'public', 'todos')",
    "execute format('create policy p on public.%I using (true)', t)",
    "execute 'drop policy p on public.' || t",
    "execute 'drop policy p on public.todos' || suffix",
    "execute 'drop policy ' || p || ' on public.todos'",
    'create policy p',
    'drop policy p; select 1 on x',
  ])('yields * for %j', (body) => {
    expect(policyMentions(body)).toEqual(['*']);
  });

  it('lists each relation once, in order, and * once', () => {
    const body = `create policy a on public.todos using (true);
      drop policy if exists b on todos;
      alter policy c on public.todos to anon;
      create policy d on public.orders using (true);
      execute format('drop policy %I on %I', x, y);
      execute format('drop policy %I on %I', z, w);`;
    expect(policyMentions(body)).toEqual([
      { schema: 'public', name: 'todos' },
      { schema: null, name: 'todos' },
      { schema: 'public', name: 'orders' },
      '*',
    ]);
  });

  it('ignores bodies without a policy statement', () => {
    expect(policyMentions('alter publication supabase_realtime add table public.todos')).toEqual(
      [],
    );
    expect(
      policyMentions('grant select on public.todos to anon; create table public.policy (id int)'),
    ).toEqual([]);
    expect(policyMentions('')).toEqual([]);
  });

  it('is filled on DO statements', () => {
    const [statement] = parser.parse(GUARDED, path(1)).statements;
    expect(statement?.kind).toBe('DynamicSql');
    expect(statement).toMatchObject({
      policyMentions: [{ schema: 'public', name: 'todos' }],
      publicationMentions: [],
      mentions: ['create policy'],
    });
  });
});

describe('replay: policies changed by DO blocks', () => {
  it('marks only the named relation, at the DO block', () => {
    const result = run([TABLES, GUARDED]);
    expect(mark(result, 'todos')).toEqual(at(2, 1));
    expect(mark(result, 'orders')).toBeNull();
    expect(mark(result, 'audit_log', 'private')).toBeNull();
    // The body is not run: the policy stays unknown to the catalog.
    expect(result.final.policiesOn({ schema: 'public', name: 'todos' })).toEqual([]);
  });

  it('resolves an unqualified name to public, and keeps a qualified schema', () => {
    const result = run([
      TABLES,
      'do $$ begin drop policy if exists p on orders; alter policy q on private.audit_log to anon; end $$;',
    ]);
    expect(mark(result, 'orders')).toEqual(at(2, 1));
    expect(mark(result, 'audit_log', 'private')).toEqual(at(2, 1));
    expect(mark(result, 'todos')).toBeNull();
  });

  it('marks every relation that exists when the name is built at run time', () => {
    const result = run([
      TABLES,
      `create view public.open_todos as select * from public.todos;
do $$ begin execute format('create policy p on %I.%I using (true)', 'public', 'todos'); end $$;
create table public.messages (id int);`,
    ]);
    for (const [schema, name] of [
      ['public', 'todos'],
      ['public', 'orders'],
      ['private', 'audit_log'],
      ['public', 'open_todos'],
    ] as const) {
      expect(mark(result, name, schema)).toEqual(at(2, 2));
    }
    expect(mark(result, 'messages')).toBeNull();
  });

  it('keeps the latest block, and no plain policy statement clears the mark', () => {
    const result = run([
      TABLES,
      GUARDED,
      `create policy todos_select on public.todos for select to authenticated using (true);
drop policy todos_select on public.todos;
alter table public.todos enable row level security;
do $$ begin drop policy if exists p on public.todos; end $$;`,
    ]);
    expect(mark(result, 'todos')).toEqual(at(3, 4));
    expect(mark(result, 'orders')).toBeNull();
  });

  it('is cleared by dropping the relation, so a table created again is not marked', () => {
    const result = run([
      TABLES,
      GUARDED,
      'drop table public.todos;\ncreate table public.todos (id int);',
    ]);
    expect(mark(result, 'todos')).toBeNull();
    expect(
      run([TABLES, GUARDED, 'drop table public.todos;']).final.policiesUncertain({
        schema: 'public',
        name: 'todos',
      }),
    ).toBeNull();
  });

  it('moves with a rename and a schema change', () => {
    const renamed = run([TABLES, GUARDED, 'alter table public.todos rename to tasks;']);
    expect(mark(renamed, 'tasks')).toEqual(at(2, 1));
    expect(mark(renamed, 'todos')).toBeNull();
    const moved = run([TABLES, GUARDED, 'alter table public.todos set schema private;']);
    expect(mark(moved, 'todos', 'private')).toEqual(at(2, 1));
    expect(mark(moved, 'todos')).toBeNull();
  });

  it('leaves the catalog unchanged for a DO block without a policy statement', () => {
    const result = run([
      TABLES,
      'do $$ begin alter publication supabase_realtime add table public.todos; end $$;',
    ]);
    expect(mark(result, 'todos')).toBeNull();
    expect(
      result.files[1]?.after.policiesUncertain({ schema: 'public', name: 'todos' }),
    ).toBeNull();
  });

  it('records no replay event', () => {
    const plain = run([TABLES, 'select 1;']);
    const withBlock = run([
      TABLES,
      "do $$ begin drop policy if exists p on public.todos; execute format('alter policy %I on %I', a, b); end $$;",
    ]);
    expect(withBlock.files[1]?.events).toEqual(plain.files[1]?.events);
    expect(withBlock.files[1]?.events).toEqual([]);
  });

  it('is copied into the snapshot', () => {
    const result = run([TABLES, GUARDED]);
    const snapshot = toSnapshot(result.final, {
      engineVersion: '0.0.0',
      configSource: 'defaults',
      files: 2,
      since: { value: null, source: null },
      parseProblems: 0,
      dynamicSql: 1,
      declarativeFiles: 0,
    });
    const byName = Object.fromEntries(snapshot.relations.map((r) => [r.name, r.policiesUncertain]));
    expect(byName).toEqual({ todos: at(2, 1), orders: null, audit_log: null });
  });
});

// Postgres has no `CREATE POLICY IF NOT EXISTS`: the parser rejects both statements.
const UNPARSEABLE = `alter table public.todos enable row level security;
create policy if not exists todos_select on public.todos for select to authenticated using (true);
CREATE POLICY IF NOT EXISTS "Orders insert" ON orders FOR INSERT WITH CHECK (true);`;

describe('unparseablePolicyMentions', () => {
  it.each([
    [
      'create policy if not exists p on public.todos for select using (true)',
      [{ schema: 'public', name: 'todos' }],
    ],
    ['ALTER POLICY p ON "Todos" TO', [{ schema: null, name: 'Todos' }]],
    ['drop  policy\np on public.todos cascade restrict', [{ schema: 'public', name: 'todos' }]],
    [
      'create policy if not exists p on public.todos using (true); create policy q on public.orders',
      [{ schema: 'public', name: 'todos' }],
    ],
  ])('reads %j', (text, expected) => {
    expect(unparseablePolicyMentions(text)).toEqual(expected);
  });

  it.each([
    'create policy if not exists p',
    'create policy if not exists p on %I using (true)',
    "create policy p on public.' || t",
    'create policyx p on public.todos',
    'create  table if not exists public.todos (',
    "select 'x' frm t; create policy p on public.todos using (true)",
    'grant selectt oon public.todos to anon -- create policy p on public.orders',
    '',
  ])('yields none for %j', (text) => {
    expect(unparseablePolicyMentions(text)).toEqual([]);
  });

  it('is filled on unparseable statements, and empty on other ones', () => {
    const statements = parser.parse(
      `${UNPARSEABLE}\ngrant selectt oon public.todos to anon;`,
      path(1),
    ).statements;
    expect(statements.map((s) => s.kind)).toEqual([
      'AlterTableRowSecurity',
      'Unparseable',
      'Unparseable',
      'Unparseable',
    ]);
    expect(statements.map((s) => (s.kind === 'Unparseable' ? s.policyMentions : null))).toEqual([
      null,
      [{ schema: 'public', name: 'todos' }],
      [{ schema: null, name: 'orders' }],
      [],
    ]);
  });
});

describe('replay: unparseable policy statements', () => {
  it('marks only the named relations, each at its statement', () => {
    const result = run([TABLES, UNPARSEABLE]);
    expect(mark(result, 'todos')).toEqual(at(2, 2));
    expect(mark(result, 'orders')).toEqual(at(2, 3));
    expect(mark(result, 'audit_log', 'private')).toBeNull();
    // The RLS enable in the same file still counts, and no policy is recorded.
    expect(result.final.relation({ schema: 'public', name: 'todos' })?.rls.enabled).toBe(true);
    expect(result.final.policiesOn({ schema: 'public', name: 'todos' })).toEqual([]);
  });

  it('leaves the catalog unchanged for any other unparseable statement', () => {
    const result = run([
      TABLES,
      'grant selectt oon public.todos to anon;\ncreate policy if not exists p;',
    ]);
    for (const [schema, name] of [
      ['public', 'todos'],
      ['public', 'orders'],
      ['private', 'audit_log'],
    ] as const) {
      expect(mark(result, name, schema)).toBeNull();
    }
  });

  it('records only the PARSE001 skips', () => {
    const result = run([TABLES, UNPARSEABLE]);
    expect(result.files[1]?.events.map((e) => [e.kind, e.kind === 'skipped' && e.reason])).toEqual([
      ['skipped', 'unparseable'],
      ['skipped', 'unparseable'],
    ]);
  });
});

describe('Catalog.markPoliciesUncertain', () => {
  it('marks names the catalog does not track, like policies on them', () => {
    const where = { file: 'm.sql', line: 3, column: 1 };
    const catalog = Catalog.create().markPoliciesUncertain(
      [{ schema: 'public', name: 'ghost' }],
      where,
    );
    expect(catalog.policiesUncertain({ schema: 'public', name: 'ghost' })).toBe(where);
    expect(catalog.policiesUncertain({ schema: 'public', name: 'other' })).toBeNull();
    expect(Catalog.create().policiesUncertain({ schema: 'public', name: 'ghost' })).toBeNull();
  });

  it('returns a new catalog and leaves the old one unchanged', () => {
    const where = { file: 'm.sql', line: 3, column: 1 };
    const before = Catalog.create();
    const after = before.markPoliciesUncertain([{ schema: 'public', name: 't' }], where);
    expect(after).not.toBe(before);
    expect(before.policiesUncertain({ schema: 'public', name: 't' })).toBeNull();
  });

  it('keeps a mark when a different relation is dropped or renamed', () => {
    const where = { file: 'm.sql', line: 3, column: 1 };
    const t = { schema: 'public', name: 't' };
    const catalog = Catalog.create()
      .createRelation(t, 'table', 'postgres', null)
      .createRelation({ schema: 'public', name: 'u' }, 'table', 'postgres', null)
      .markPoliciesUncertain([t], where)
      .dropRelation({ schema: 'public', name: 'u' })
      .createRelation({ schema: 'public', name: 'v' }, 'table', 'postgres', null)
      .moveRelation({ schema: 'public', name: 'v' }, { schema: 'public', name: 'w' });
    expect(catalog.policiesUncertain(t)).toBe(where);
    expect(catalog.policiesUncertain({ schema: 'public', name: 'w' })).toBeNull();
  });
});
