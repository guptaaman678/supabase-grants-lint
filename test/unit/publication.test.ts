import { beforeAll, describe, expect, it } from 'vitest';
import { loadParser, type MigrationParser, publicationMentions } from '../../src/parse/adapter.js';
import type { Statement, StatementKind } from '../../src/parse/ir.js';
import type { Catalog, PublicationState } from '../../src/model/relations.js';
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

function run(sources: readonly string[], platformPublications?: readonly string[]): ReplayResult {
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
      ...(platformPublications === undefined ? {} : { platformPublications }),
    },
  );
}

function pub(catalog: Catalog, name: string): PublicationState {
  const publication = catalog.publication(name);
  if (publication === undefined) throw new Error(`no publication ${name}`);
  return publication;
}

function fileOf(result: ReplayResult, n: number): FileReplay {
  const file = result.files[n - 1];
  if (file === undefined) throw new Error(`no file ${String(n)}`);
  return file;
}

/** `schema.name` strings, for compact membership assertions. */
function names(list: readonly { schema: string; name: string }[]): string[] {
  return list.map((t) => `${t.schema}.${t.name}`);
}

function at(file: number, line: number, column = 1) {
  return { file: path(file), line, column };
}

const REALTIME = 'supabase_realtime';

describe('parse: publications', () => {
  it('maps CREATE PUBLICATION FOR TABLE, dropping row filters and column lists', () => {
    expect(
      one(
        'create publication audit for table todos, public."Orders" (id) where (id > 0);',
        'Publication',
      ),
    ).toMatchObject({
      action: 'create',
      name: 'audit',
      allTables: false,
      tables: [
        { schema: null, name: 'todos' },
        { schema: 'public', name: 'Orders' },
      ],
      schemas: [],
    });
  });

  it('maps FOR ALL TABLES, FOR TABLES IN SCHEMA and a bare CREATE', () => {
    expect(one('create publication everything for all tables;', 'Publication')).toMatchObject({
      action: 'create',
      allTables: true,
      tables: [],
      schemas: [],
    });
    expect(
      one(
        'create publication p for tables in schema private, current_schema, table public.todos;',
        'Publication',
      ),
    ).toMatchObject({
      action: 'create',
      allTables: false,
      tables: [{ schema: 'public', name: 'todos' }],
      schemas: ['private', null],
    });
    expect(one('create publication "My Pub";', 'Publication')).toMatchObject({
      action: 'create',
      name: 'My Pub',
      allTables: false,
      tables: [],
      schemas: [],
    });
  });

  it('maps ALTER PUBLICATION ADD (with ONLY), DROP and SET', () => {
    expect(
      one('alter publication supabase_realtime add table only public.todos;', 'Publication'),
    ).toMatchObject({
      action: 'alter',
      name: REALTIME,
      op: 'add',
      tables: [{ schema: 'public', name: 'todos' }],
    });
    expect(one('alter publication p drop table todos, orders;', 'Publication')).toMatchObject({
      action: 'alter',
      op: 'drop',
      tables: [
        { schema: null, name: 'todos' },
        { schema: null, name: 'orders' },
      ],
    });
    expect(
      one('alter publication p set table messages, tables in schema private;', 'Publication'),
    ).toMatchObject({
      action: 'alter',
      op: 'set',
      tables: [{ schema: null, name: 'messages' }],
      schemas: ['private'],
    });
    expect(
      one('alter publication p add tables in schema current_schema;', 'Publication'),
    ).toMatchObject({ action: 'alter', op: 'add', tables: [], schemas: [null] });
  });

  it('maps OWNER TO and SET (publish ...) to membership no-ops', () => {
    expect(one('alter publication supabase_realtime owner to postgres;', 'Publication')).toEqual(
      expect.objectContaining({ action: 'noop', name: REALTIME, change: 'owner' }),
    );
    expect(one(`alter publication p set (publish = 'insert, update');`, 'Publication')).toEqual(
      expect.objectContaining({ action: 'noop', name: 'p', change: 'options' }),
    );
  });

  it('maps RENAME TO and DROP PUBLICATION', () => {
    expect(one('alter publication p rename to q;', 'Publication')).toMatchObject({
      action: 'rename',
      name: 'p',
      newName: 'q',
    });
    expect(one('drop publication if exists p, "Q" cascade;', 'Publication')).toMatchObject({
      action: 'drop',
      names: ['p', 'Q'],
      ifExists: true,
    });
    expect(one('drop publication p;', 'Publication')).toMatchObject({ ifExists: false });
  });

  it('leaves ALTER OWNER of other objects Unknown', () => {
    expect(one('alter schema private owner to postgres;', 'Unknown')).toMatchObject({
      nodeType: 'AlterOwnerStmt',
    });
  });
});

describe('parse: function calls', () => {
  it('maps a SELECT of only function calls, and CALL', () => {
    expect(one('select public.seed(), seed_more(1);', 'FunctionCall').functions).toEqual([
      { schema: 'public', name: 'seed' },
      { schema: null, name: 'seed_more' },
    ]);
    expect(one('select seed() as done where true;', 'FunctionCall').functions).toEqual([
      { schema: null, name: 'seed' },
    ]);
    expect(one('call private.seed(1);', 'FunctionCall').functions).toEqual([
      { schema: 'private', name: 'seed' },
    ]);
  });

  it('leaves any other SELECT Unknown', () => {
    for (const sql of [
      'select seed() from todos;',
      'select 1, seed();',
      'select seed() into new_table;',
      'values (seed());',
      'select 1 union select seed();',
    ]) {
      expect(one(sql, 'Unknown')).toMatchObject({ nodeType: 'SelectStmt' });
    }
  });
});

describe('publicationMentions', () => {
  it.each([
    ['alter publication supabase_realtime add table public.todos', [REALTIME]],
    ['ALTER  PUBLICATION\n  Supabase_Realtime ADD TABLE x', [REALTIME]],
    ['alter publication "My ""Pub""" add table x', ['My "Pub"']],
    ['drop publication if exists a, "B" , c;', ['a', 'B', 'c']],
    ['drop publication if  exists  a,  b;', ['a', 'b']],
    ['drop publication p', ['p']],
    ['create publication p for all tables', ['p']],
    [`execute 'drop publication old_pub';`, ['old_pub']],
    ['alter publication p add table a; alter publication p drop table b;', ['p']],
    [`execute format('alter publication %I add table %I', pub, t);`, ['*']],
    [`execute 'alter publication ' || pub || ' add table x';`, ['*']],
    [`execute 'alter publication pub_' || suffix;`, ['*']],
    [`execute format('alter publication pub_%s add table x', n);`, ['*']],
    ["execute 'alter publication '|| p;", ['*']],
    ["execute 'alter publication pub_'||suffix;", ['*']],
    ['alter publication 1 a;', ['*']],
    ['create table publications (id int); select 1;', []],
    ['grant select on table x to anon', []],
  ])('%j -> %j', (body, expected) => {
    expect(publicationMentions(body)).toEqual(expected);
  });

  it('is kept apart from the PARSE002 keywords of a DO block', () => {
    const block = one(
      `do $$ begin execute format('alter publication supabase_realtime add table public.%I', 'todos'); end $$;`,
      'DynamicSql',
    );
    expect(block.mentions).toEqual([]);
    expect(block.publicationMentions).toEqual([REALTIME]);
  });

  it('scans function bodies', () => {
    expect(
      one(
        'create function public.seed() returns void language plpgsql as $f$ begin alter publication supabase_realtime add table todos; end $f$;',
        'FunctionDefinition',
      ).publicationMentions,
    ).toEqual([REALTIME]);
    expect(
      one(
        `create function public.native() returns int language c as 'module', 'symbol';`,
        'FunctionDefinition',
      ).publicationMentions,
    ).toEqual([]);
    expect(
      one('create function f() returns int language sql return 1;', 'FunctionDefinition')
        .publicationMentions,
    ).toEqual([]);
    expect(
      one('create function f() returns int return 1;', 'FunctionDefinition').publicationMentions,
    ).toEqual([]);
  });

  it('scans only the AS strings of a function, one per line', () => {
    // A verb at the very end names nothing; the LANGUAGE option is not part of the body.
    expect(
      one(
        `create function f() returns void as 'alter publication' language plpgsql;`,
        'FunctionDefinition',
      ).publicationMentions,
    ).toEqual([]);
    expect(
      one(
        `create function f() returns int language c as 'alter publication', 'p';`,
        'FunctionDefinition',
      ).publicationMentions,
    ).toEqual(['p']);
  });
});

describe('replay: initial state', () => {
  it('starts with an empty supabase_realtime by default', () => {
    const result = run([]);
    expect(result.initial.publications()).toEqual([
      {
        name: REALTIME,
        origin: 'platform',
        allTables: false,
        schemas: [],
        tables: [],
        uncertain: null,
        excluded: [],
      },
    ]);
  });

  it('follows platformPublications', () => {
    expect(run([], []).final.publications()).toEqual([]);
    expect(
      run([], ['a', 'b'])
        .final.publications()
        .map((p) => p.name),
    ).toEqual(['a', 'b']);
  });
});

describe('replay: publication membership', () => {
  it('adds tables with ADD TABLE ONLY and resolves unqualified names to public', () => {
    const result = run([
      'create table todos (id int);',
      'alter publication supabase_realtime add table only todos, private.audit_log, todos;',
    ]);
    const realtime = pub(result.final, REALTIME);
    expect(names(realtime.tables)).toEqual(['public.todos', 'private.audit_log']);
    expect(realtime.origin).toBe('platform');
    expect(realtime.uncertain).toBeNull();
  });

  it('models FOR ALL TABLES and FOR TABLES IN SCHEMA (CURRENT_SCHEMA is public)', () => {
    const result = run([
      `create publication everything for all tables;
       create publication schemas for tables in schema private, current_schema, private;`,
    ]);
    expect(pub(result.final, 'everything')).toMatchObject({
      origin: 'migration',
      allTables: true,
      schemas: [],
      tables: [],
    });
    expect(pub(result.final, 'schemas').schemas).toEqual(['private', 'public']);
  });

  it('adds and drops schemas', () => {
    const result = run([
      `create publication p for tables in schema private;
       alter publication p add tables in schema public, private;
       alter publication p drop tables in schema private;`,
    ]);
    expect(pub(result.final, 'p').schemas).toEqual(['public']);
  });

  it('drops tables, and SET TABLE replaces the tables and schemas', () => {
    const result = run([
      `create publication p for table todos, orders, tables in schema private;
       alter publication p drop table orders;`,
      'alter publication p set table messages, tables in schema audit;',
    ]);
    expect(names(pub(fileOf(result, 1).after, 'p').tables)).toEqual(['public.todos']);
    expect(pub(result.final, 'p')).toMatchObject({ schemas: ['audit'], excluded: [] });
    expect(names(pub(result.final, 'p').tables)).toEqual(['public.messages']);
  });

  it('adds to the current tables, and drops several tables at once', () => {
    const result = run([
      `alter publication supabase_realtime add table todos;
       alter publication supabase_realtime add table orders, messages;`,
      'alter publication supabase_realtime drop table todos, messages;',
    ]);
    expect(names(pub(fileOf(result, 1).after, REALTIME).tables)).toEqual([
      'public.todos',
      'public.orders',
      'public.messages',
    ]);
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.orders']);
  });

  it('treats OWNER TO and SET (publish ...) as no-ops on a known publication', () => {
    const before = run(['alter publication supabase_realtime add table todos;']);
    const after = run([
      `alter publication supabase_realtime add table todos;
       alter publication supabase_realtime owner to postgres;
       alter publication supabase_realtime set (publish = 'insert');`,
    ]);
    expect(after.final.publications()).toEqual(before.final.publications());
  });

  it('removes a dropped table from every publication', () => {
    const result = run([
      `create table todos (id int);
       create publication p for table todos;
       alter publication supabase_realtime add table todos;`,
      'drop table todos;',
    ]);
    expect(pub(result.final, 'p').tables).toEqual([]);
    expect(pub(result.final, REALTIME).tables).toEqual([]);
    expect(pub(result.final, REALTIME).excluded).toEqual([]);
  });

  it('keeps the other members when a table is dropped', () => {
    const result = run([
      `create table todos (id int);
       create table orders (id int);
       alter publication supabase_realtime add table todos, orders;`,
      'drop table todos;',
    ]);
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.orders']);
  });

  it('keeps a renamed table, or one moved to another schema, in its publications', () => {
    const result = run([
      `create table todos (id int);
       alter publication supabase_realtime add table todos;`,
      'alter table todos rename to tasks;',
      'alter table tasks set schema private;',
    ]);
    expect(names(pub(fileOf(result, 2).after, REALTIME).tables)).toEqual(['public.tasks']);
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['private.tasks']);
  });

  it('renames membership of a table the migrations do not create', () => {
    const result = run([
      'alter publication supabase_realtime add table orders;',
      'alter table orders rename to scores;',
      'alter table untouched rename to other;',
    ]);
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.scores']);
  });

  it('renames such a table when only one of several publications lists it, among other tables', () => {
    const result = run([
      'create publication p for table todos, orders;',
      'alter table orders rename to scores;',
    ]);
    expect(names(pub(result.final, 'p').tables)).toEqual(['public.todos', 'public.scores']);
    expect(pub(result.final, REALTIME).tables).toEqual([]);
    const only = run(
      ['create publication p for table todos, orders;', 'alter table orders rename to scores;'],
      [],
    );
    expect(names(pub(only.final, 'p').tables)).toEqual(['public.todos', 'public.scores']);
  });

  it('reads DROP PUBLICATION IF EXISTS then CREATE PUBLICATION as a fresh definition', () => {
    const result = run([
      `alter publication supabase_realtime add table todos;`,
      `drop publication if exists supabase_realtime;
       create publication supabase_realtime for table messages;`,
    ]);
    expect(pub(result.final, REALTIME)).toMatchObject({
      origin: 'migration',
      uncertain: null,
      excluded: [],
    });
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.messages']);
    expect(result.final.notes()).toEqual([]);
  });

  it('records a note when CREATE PUBLICATION redefines an existing one', () => {
    const result = run([
      `alter publication supabase_realtime add table todos;
create publication supabase_realtime for table messages;`,
    ]);
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.messages']);
    expect(pub(result.final, REALTIME).origin).toBe('migration');
    expect(result.final.notes()).toEqual([
      {
        code: 'publication-redefined',
        message:
          'CREATE PUBLICATION supabase_realtime redefines a publication that already exists; its earlier membership is replaced.',
        at: at(1, 2),
      },
    ]);
  });

  it('never touches supabase_realtime from a publication of another name', () => {
    const result = run([
      `create publication other for all tables;
       alter publication other add table todos;
       drop publication other;`,
    ]);
    expect(result.final.publications()).toEqual(result.initial.publications());
  });

  it('creates a publication first seen in an ALTER as unseen and uncertain', () => {
    const result = run([
      'alter publication custom add table todos;',
      'alter publication owned owner to postgres;',
      `alter publication opts set (publish = 'insert');`,
    ]);
    expect(pub(result.final, 'custom')).toMatchObject({
      origin: 'unseen',
      allTables: false,
      schemas: [],
      uncertain: at(1, 1),
      excluded: [],
    });
    expect(names(pub(result.final, 'custom').tables)).toEqual(['public.todos']);
    expect(pub(result.final, 'owned')).toMatchObject({ origin: 'unseen', uncertain: at(2, 1) });
    expect(pub(result.final, 'opts')).toMatchObject({ origin: 'unseen', uncertain: at(3, 1) });
  });

  it('renames a publication, ignoring a rename onto a taken name', () => {
    const result = run([
      `create publication a for table todos;
       create publication b;
       alter publication a rename to b;`,
      'alter publication a rename to c;',
      'alter publication ghost rename to seen;',
    ]);
    expect(names(pub(fileOf(result, 1).after, 'a').tables)).toEqual(['public.todos']);
    expect(pub(fileOf(result, 1).after, 'b').tables).toEqual([]);
    expect(result.final.publication('a')).toBeUndefined();
    expect(names(pub(result.final, 'c').tables)).toEqual(['public.todos']);
    expect(pub(result.final, 'seen')).toMatchObject({ origin: 'unseen', uncertain: at(3, 1) });
  });

  it('drops a list of publications, missing ones included', () => {
    const result = run([
      `create publication a;
       create publication b;
       drop publication if exists a, b, missing;`,
    ]);
    expect(result.final.publications().map((p) => p.name)).toEqual([REALTIME]);
  });

  it('records no replay events', () => {
    const result = run([
      'create table todos (id int);',
      `create publication p for all tables;
       alter publication supabase_realtime add table todos;
       alter publication supabase_realtime owner to postgres;
       alter publication p rename to q;
       drop publication q;
       create function public.seed() returns void language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;
       select public.seed();
       call public.seed();
       do $$ begin alter publication supabase_realtime drop table todos; end $$;
       drop function public.seed();`,
    ]);
    expect(fileOf(result, 2).events).toEqual([]);
  });
});

const SEED = `do $$
declare t text;
begin
  foreach t in array array['todos', 'messages'] loop
    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end $$;`;

describe('replay: publications changed by DO blocks and functions (ADR-015)', () => {
  it('marks a DO seed uncertain at the block, keeping known members', () => {
    const result = run([
      `create table todos (id int);
       alter publication supabase_realtime add table todos;`,
      SEED,
    ]);
    expect(pub(result.final, REALTIME)).toMatchObject({ uncertain: at(2, 1), excluded: [] });
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.todos']);
  });

  it('excludes a table a plain statement drops after the seed, until it is added back', () => {
    const result = run([
      SEED,
      'alter publication supabase_realtime drop table public.messages, public.todos;',
      'alter publication supabase_realtime add table todos;',
    ]);
    expect(names(pub(fileOf(result, 2).after, REALTIME).excluded)).toEqual([
      'public.messages',
      'public.todos',
    ]);
    expect(pub(result.final, REALTIME)).toMatchObject({ uncertain: at(1, 1) });
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.todos']);
    expect(names(pub(result.final, REALTIME).excluded)).toEqual(['public.messages']);
  });

  it('keeps the mark through SET TABLE, excluding the members it removes', () => {
    const result = run([
      'alter publication supabase_realtime add table orders;',
      SEED,
      'alter publication supabase_realtime set table todos;',
    ]);
    expect(pub(result.final, REALTIME)).toMatchObject({ uncertain: at(2, 1) });
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.todos']);
    expect(names(pub(result.final, REALTIME).excluded)).toEqual(['public.orders']);
  });

  it('excludes a table dropped after the seed, so a new table of that name is not a member', () => {
    const result = run([SEED, 'drop table if exists messages;']);
    expect(names(pub(result.final, REALTIME).excluded)).toEqual(['public.messages']);
  });

  it('keeps the earlier exclusions when another table is dropped after the seed', () => {
    const result = run([
      SEED,
      'alter publication supabase_realtime drop table orders;',
      'drop table if exists todos;',
    ]);
    expect(names(pub(result.final, REALTIME).excluded)).toEqual(['public.orders', 'public.todos']);
    const statements = run([
      SEED,
      'alter publication supabase_realtime drop table orders;',
      'alter publication supabase_realtime drop table todos;',
    ]);
    expect(names(pub(statements.final, REALTIME).excluded)).toEqual([
      'public.orders',
      'public.todos',
    ]);
  });

  it('renames an excluded table with the table', () => {
    const result = run([
      SEED,
      'alter publication supabase_realtime drop table orders;',
      'alter table orders rename to scores;',
    ]);
    expect(names(pub(result.final, REALTIME).excluded)).toEqual(['public.scores']);
  });

  it('clears the mark on a plain DROP PUBLICATION', () => {
    const result = run([SEED, 'drop publication supabase_realtime;']);
    expect(result.final.publication(REALTIME)).toBeUndefined();
  });

  it('clears the mark on a plain redefinition', () => {
    const result = run([SEED, 'create publication supabase_realtime for table todos;']);
    expect(pub(result.final, REALTIME)).toMatchObject({ uncertain: null, excluded: [] });
    expect(names(pub(result.final, REALTIME).tables)).toEqual(['public.todos']);
  });

  it('lets a later block reset the exclusions', () => {
    const result = run([
      SEED,
      'alter publication supabase_realtime drop table todos;',
      `do $$ begin alter publication supabase_realtime add table public.todos; end $$;`,
    ]);
    expect(pub(result.final, REALTIME)).toMatchObject({ uncertain: at(3, 1), excluded: [] });
  });

  it("marks every publication for a '*' mention", () => {
    const result = run([
      `create publication a for table todos;
       create publication b;`,
      `do $$ begin execute format('alter publication %I add table todos', 'a'); end $$;`,
    ]);
    for (const name of [REALTIME, 'a', 'b']) {
      expect(pub(result.final, name).uncertain).toEqual(at(2, 1));
    }
    expect(names(pub(result.final, 'a').tables)).toEqual(['public.todos']);
  });

  it('creates a publication a block names but the migrations never saw, as unseen', () => {
    const result = run([`do $$ begin create publication extra for all tables; end $$;`], []);
    expect(pub(result.final, 'extra')).toMatchObject({
      origin: 'unseen',
      allTables: false,
      uncertain: at(1, 1),
    });
  });

  it('marks the publications of a function at the top-level call, not at its definition', () => {
    const fn = `create or replace function public.seed_realtime() returns void language plpgsql as $$
begin
  alter publication supabase_realtime add table public.todos;
end $$;`;
    const result = run([fn, 'select 1;', 'select public.seed_realtime();']);
    expect(pub(fileOf(result, 2).after, REALTIME).uncertain).toBeNull();
    expect(pub(result.final, REALTIME).uncertain).toEqual(at(3, 1));
  });

  it('resolves an unqualified call to public, and marks on CALL', () => {
    const result = run([
      `create procedure seed() language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;`,
      'call seed();',
    ]);
    expect(pub(result.final, REALTIME).uncertain).toEqual(at(2, 1));
  });

  it('marks on a DO block that performs the function', () => {
    const result = run([
      `create function public.seed() returns void language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;`,
      `do $$ begin perform public."seed"(); end $$;`,
    ]);
    expect(pub(result.final, REALTIME).uncertain).toEqual(at(2, 1));
  });

  it('does not mark for calls of other functions', () => {
    const result = run([
      `create function public.seed() returns void language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;`,
      `select public.other(), private.seed();
       do $$ begin perform reseed(); end $$;`,
    ]);
    expect(pub(result.final, REALTIME).uncertain).toBeNull();
    expect(result.final.publications().map((p) => p.name)).toEqual([REALTIME]);
  });

  it('matches a called name case-insensitively, and literally', () => {
    const upper = run([
      `create function public.seed() returns void language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;`,
      `do $$ begin perform Public.SEED(); end $$;`,
    ]);
    expect(pub(upper.final, REALTIME).uncertain).toEqual(at(2, 1));
    const dollar = run([
      `create function public.seed$x() returns void language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;`,
      `do $$ begin perform seed$x(); end $$;`,
    ]);
    expect(pub(dollar.final, REALTIME).uncertain).toEqual(at(2, 1));
  });

  it('forgets a function replaced without mentions, or dropped', () => {
    const mentions = `create or replace function public.seed() returns void language plpgsql as $$ begin alter publication supabase_realtime add table x; end $$;`;
    const replaced = run([
      mentions,
      `create or replace function public.seed() returns void language plpgsql as $$ begin end $$;`,
      'select public.seed();',
    ]);
    expect(pub(replaced.final, REALTIME).uncertain).toBeNull();
    const dropped = run([
      mentions,
      'drop function public.seed(), public.missing();',
      'select public.seed();',
    ]);
    expect(pub(dropped.final, REALTIME).uncertain).toBeNull();
  });
});
