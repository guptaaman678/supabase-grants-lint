import { beforeAll, describe, expect, it } from 'vitest';
import { usage } from '../../src/cli/usage.js';
import { type Config, DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { buildSnapshot, type RawCatalog } from '../../src/live/snapshot.js';
import { Catalog } from '../../src/model/relations.js';
import { loadParser, type MigrationParser } from '../../src/parse/adapter.js';
import { sarifRules } from '../../src/report/sarif.js';
import { replayWithWindow } from '../../src/replay/since.js';
import { comparedPrivileges, GL009 } from '../../src/rules/GL009.js';
import { docsUrl, type Finding, RULES, runRules } from '../../src/rules/index.js';

let parser: MigrationParser;

beforeAll(async () => {
  parser = await loadParser();
});

const API = ['anon', 'authenticated', 'service_role'];
const all = (letters: string) => API.map((role) => `${role}=${letters}/postgres`);

/** A Supabase project before the change: `postgres` grants everything on new objects in public. */
const LEGACY_ROWS: RawCatalog['defaults'] = [
  { creator: 'postgres', schema: 'public', objtype: 'r', acl: all('arwdDxtm') },
  { creator: 'postgres', schema: 'public', objtype: 'S', acl: all('rwU') },
];

function database(raw: Partial<RawCatalog> = {}): RawCatalog {
  return {
    serverVersion: 170002,
    relations: [],
    columns: [],
    defaults: LEGACY_ROWS,
    policies: [],
    ...raw,
  };
}

const TODOS = 'create table public.todos (id uuid primary key, title text);';
const TODOS_ROW = { schema: 'public', name: 'todos', relkind: 'r', acl: all('arwdDxtm') };

function inputs(sources: readonly string[]) {
  return sources.map((source, i) => {
    const version = `2026100${String(i + 1)}000000`;
    const file = `supabase/migrations/${version}_m.sql`;
    return { file, version, statements: parser.parse(source, file).statements };
  });
}

/** Replays the sources and compares them with the database, GL009 only. */
function drift(
  sql: string | readonly string[],
  raw: Partial<RawCatalog>,
  config: Partial<Config> = {},
): readonly Finding[] {
  const full = { ...DEFAULT_CONFIG, ...config };
  const replay = replayWithWindow(inputs(typeof sql === 'string' ? [sql] : sql), full);
  return runRules({ config: full, replay, rules: [GL009], live: buildSnapshot(database(raw)) })
    .findings;
}

const brief = (findings: readonly Finding[]) =>
  findings.map((f) => [f.relation, f.role, f.privilege, f.message.split(':')[0]]);

const FILE = 'supabase/migrations/20261001000000_m.sql';

describe('GL009 drift', () => {
  it('finds nothing when the database has what the migrations give', () => {
    expect(drift(TODOS, { relations: [TODOS_ROW] })).toEqual([]);
  });

  it('finds nothing without a live database (check never connects)', () => {
    const replay = replayWithWindow(inputs([TODOS]), DEFAULT_CONFIG);
    expect(GL009.check({ ...fakeContext(replay) })).toEqual([]);
  });

  it('reports a privilege the database has and the migrations do not, at the CREATE', () => {
    const findings = drift(
      `select 1;\n${TODOS}\nrevoke delete, truncate on public.todos from anon;`,
      {
        relations: [TODOS_ROW],
      },
    );
    expect(findings).toEqual([
      {
        ruleId: 'GL009',
        severity: 'warn',
        message:
          'In the database, not in the migrations: anon holds delete, truncate on public.todos. ' +
          'A database built from the migrations (a new project, a preview branch, a local reset) ' +
          'will not have it: add the grant to a migration, or revoke it in the database if it ' +
          'was not meant.',
        file: FILE,
        line: 2,
        column: 1,
        relation: 'public.todos',
        role: 'anon',
        privilege: 'delete, truncate',
        fix: 'grant delete, truncate on public.todos to anon;',
        docsUrl: docsUrl('GL009'),
      },
    ]);
    expect(findings[0]?.message).not.toContain(String.fromCodePoint(0x2014)); // G7
  });

  it('reports a privilege the migrations give and the database does not', () => {
    const findings = drift(TODOS, {
      relations: [
        { ...TODOS_ROW, acl: [...all('arwdDxtm').slice(0, 2), 'service_role=r/postgres'] },
      ],
    });
    expect(findings.map((f) => [f.role, f.privilege, f.message, f.fix])).toEqual([
      [
        'service_role',
        'insert, update, delete, truncate, references, trigger, maintain',
        'In the migrations, not in the database: the migrations give service_role insert, ' +
          'update, delete, truncate, references, trigger, maintain on public.todos, the database ' +
          'does not. Apply the pending migrations, or find who revoked it.',
        'grant insert, update, delete, truncate, references, trigger, maintain on public.todos ' +
          'to service_role;',
      ],
    ]);
  });

  it('compares MAINTAIN only on Postgres 17 and later', () => {
    const noMaintain = { relations: [{ ...TODOS_ROW, acl: all('arwdDxt') }] };
    expect(drift(TODOS, { ...noMaintain, serverVersion: 150008 })).toEqual([]);
    expect(brief(drift(TODOS, { ...noMaintain, serverVersion: 170000 }))).toEqual(
      API.map((role) => [
        'public.todos',
        role,
        'maintain',
        'In the migrations, not in the database',
      ]),
    );
    expect(comparedPrivileges('table', 169999)).not.toContain('maintain');
    expect(comparedPrivileges('sequence', 170000)).toEqual(['usage', 'select', 'update']);
  });

  it('compares PUBLIC and configured roles, own grants only, columns counting', () => {
    const findings = drift(
      `${TODOS}\ngrant select (title) on public.todos to reporting;`,
      {
        relations: [{ ...TODOS_ROW, acl: [...all('arwdDxtm'), '=r/postgres', 'other=r/postgres'] }],
        columns: [{ schema: 'public', name: 'todos', column: 'id', acl: ['reporting=r/postgres'] }],
      },
      { clientRoles: ['anon', 'authenticated', 'reporting'] },
    );
    expect(brief(findings)).toEqual([
      ['public.todos', 'PUBLIC', 'select', 'In the database, not in the migrations'],
    ]);
  });

  it('reports a relation the migrations create that the database lacks', () => {
    expect(drift(TODOS, {})).toEqual([
      expect.objectContaining({
        file: FILE,
        line: 1,
        relation: 'public.todos',
        message:
          'In the migrations, not in the database: public.todos does not exist in the database: ' +
          'a migration was not applied, or the relation was dropped or renamed by hand.',
      }),
    ]);
  });

  it('reports a relation only the database has, on the last migration file', () => {
    const findings = drift([TODOS, 'select 1;'], {
      relations: [TODOS_ROW, { schema: 'public', name: 'notes', relkind: 'v', acl: null }],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        file: 'supabase/migrations/20261002000000_m.sql',
        line: 1,
        column: 1,
        relation: 'public.notes',
        message:
          'In the database, not in the migrations: view public.notes exists, but no migration ' +
          'creates it (made in the dashboard or the SQL editor?), so check cannot see its ' +
          'grants. Capture it in a migration (supabase db diff).',
      }),
    ]);
  });

  it('ignores relations, sequences and policies outside the configured schemas', () => {
    const findings = drift('create table private.jobs (id bigserial primary key);', {
      relations: [
        { schema: 'private', name: 'other', relkind: 'r', acl: null },
        { schema: 'private', name: 'jobs_id_seq', relkind: 'S', acl: null },
      ],
      policies: [{ schema: 'private', table: 'other', name: 'p', cmd: 'ALL', roles: ['anon'] }],
    });
    expect(findings).toEqual([]);
  });

  it('compares sequences the migrations and the database both have', () => {
    const table = 'create table public.orders (id bigserial primary key);';
    const orders = { schema: 'public', name: 'orders', relkind: 'r', acl: all('arwdDxtm') };
    const seq = { schema: 'public', name: 'orders_id_seq', relkind: 'S', acl: all('rwU') };
    expect(drift(table, { relations: [orders, seq] })).toEqual([]);
    // Identity and extension sequences are not read, so a missing one is not drift.
    expect(drift(table, { relations: [orders] })).toEqual([]);
    const findings = drift(table, {
      relations: [orders, { ...seq, acl: [...all('rwU').slice(1), 'anon=rw/postgres'] }],
    });
    expect(findings.map((f) => [f.relation, f.role, f.privilege, f.line, f.fix])).toEqual([
      [
        'public.orders_id_seq',
        'anon',
        'usage',
        1,
        'grant usage on sequence public.orders_id_seq to anon;',
      ],
    ]);
    expect(findings[0]?.message).toContain('anon usage on sequence public.orders_id_seq');
  });

  it('reports default privileges the migrations keep and the database dropped (opted in)', () => {
    const findings = drift(TODOS, { relations: [TODOS_ROW], defaults: [] });
    // Same location, so sorted by role, then privileges.
    expect(brief(findings)).toEqual(
      API.flatMap((role) => [
        [
          undefined,
          role,
          'select, insert, update, delete, truncate, references, trigger, maintain',
          'In the migrations, not in the database',
        ],
        [undefined, role, 'usage, select, update', 'In the migrations, not in the database'],
      ]),
    );
    expect(findings[0]).toMatchObject({ file: FILE, line: 1, column: 1 });
    expect(findings[0]?.message).toBe(
      'In the migrations, not in the database: new tables that postgres creates in schema ' +
        'public give anon select, insert, update, delete, truncate, references, trigger, ' +
        'maintain automatically, the database does not (opted in from the dashboard, or the ' +
        '2026-10-30 change). A local reset or preview branch still grants them; add the opt-in ' +
        'migration that supabase-grants-lint doctor prints.',
    );
    expect(findings[0]?.fix).toBeUndefined();
  });

  it('reports default privileges the database keeps and the migrations revoked', () => {
    const optIn =
      'alter default privileges for role postgres in schema public revoke select on tables from anon;';
    const findings = drift(optIn, {
      defaults: [
        { creator: 'postgres', schema: null, objtype: 'r', acl: ['anon=r/postgres'] },
        ...LEGACY_ROWS.slice(1),
        { creator: 'postgres', schema: 'public', objtype: 'r', acl: all('arwdDxtm').slice(1) },
        { creator: 'postgres', schema: 'public', objtype: 'r', acl: ['anon=awdDxtm/postgres'] },
      ],
    });
    expect(findings.map((f) => f.message)).toEqual([
      'In the database, not in the migrations: new tables that postgres creates in schema public ' +
        'give anon select automatically. The migrations do not: new relations in production get ' +
        'grants that a database built from the migrations will not give them.',
    ]);
  });

  it('compares defaults of migrationRole in every configured schema', () => {
    const findings = drift(
      'select 1;',
      {
        defaults: [
          ...LEGACY_ROWS,
          { creator: 'admin', schema: 'api', objtype: 'r', acl: ['anon=r/admin'] },
        ],
      },
      { schemas: ['public', 'api'], migrationRole: 'admin' },
    );
    expect(findings.map((f) => f.message.split(' automatically')[0])).toEqual([
      'In the database, not in the migrations: new tables that admin creates in schema api give anon select',
    ]);
  });

  describe('policies', () => {
    const POLICY = `${TODOS}\ncreate policy "read" on public.todos for select to authenticated using (true);`;
    const ROW = {
      schema: 'public',
      table: 'todos',
      name: 'read',
      cmd: 'SELECT',
      roles: ['authenticated'],
    };

    it('finds nothing when name, command and roles match', () => {
      expect(drift(POLICY, { relations: [TODOS_ROW], policies: [ROW] })).toEqual([]);
    });

    it('reports a policy only the migrations have, at its CREATE or latest ALTER', () => {
      expect(drift(POLICY, { relations: [TODOS_ROW] })).toEqual([
        expect.objectContaining({
          line: 2,
          relation: 'public.todos',
          message:
            'In the migrations, not in the database: policy "read" on public.todos does not ' +
            'exist in the database.',
        }),
      ]);
      const altered = `${POLICY}\n\nalter policy "read" on public.todos to authenticated, anon;`;
      expect(drift(altered, { relations: [TODOS_ROW] }).map((f) => f.line)).toEqual([4]);
    });

    it('reports a policy only the database has', () => {
      const findings = drift(TODOS, {
        relations: [TODOS_ROW],
        policies: [ROW, { ...ROW, table: 'gone', name: 'x' }],
      });
      expect(findings.map((f) => [f.relation, f.line, f.message])).toEqual([
        [
          'public.gone',
          1,
          'In the database, not in the migrations: policy "x" on public.gone exists, but no ' +
            'migration creates it. Capture it in a migration, or drop it if it was not meant.',
        ],
        [
          'public.todos',
          1,
          'In the database, not in the migrations: policy "read" on public.todos exists, but no ' +
            'migration creates it. Capture it in a migration, or drop it if it was not meant.',
        ],
      ]);
    });

    it('reports a different command and each role on one side only, PUBLIC included', () => {
      const findings = drift(POLICY, {
        relations: [TODOS_ROW],
        policies: [{ ...ROW, cmd: 'ALL', roles: ['public', 'anon'] }],
      });
      expect(findings.map((f) => [f.role, f.message])).toEqual([
        [
          undefined,
          'policy "read" on public.todos is for ALL in the database and for SELECT in the migrations.',
        ],
        [
          'PUBLIC',
          'In the database, not in the migrations: policy "read" on public.todos applies to PUBLIC.',
        ],
        [
          'anon',
          'In the database, not in the migrations: policy "read" on public.todos applies to anon.',
        ],
        [
          'authenticated',
          'In the migrations, not in the database: policy "read" on public.todos applies to ' +
            'authenticated.',
        ],
      ]);
    });
  });

  describe('where findings without a migration line go', () => {
    const DB = { relations: [{ schema: 'public', name: 'x', relkind: 'r', acl: null }] };

    it('uses config migrations when there are no migration files', () => {
      expect(drift([], DB).map((f) => f.file)).toEqual(['supabase/migrations']);
      expect(drift([], DB, { migrations: ['db/a', 'db/b'] }).map((f) => f.file)).toEqual(['db/a']);
      expect(drift([], DB, { migrations: [] }).map((f) => f.file)).toEqual(['']);
    });

    it('uses the last migration file for a relation without a CREATE location', () => {
      const replay = replayWithWindow(inputs(['select 1;']), DEFAULT_CONFIG);
      const final = Catalog.create(replay.final.defaults).createRelation(
        { schema: 'public', name: 'todos' },
        'table',
        'postgres',
        null,
      );
      const findings = runRules({
        config: DEFAULT_CONFIG,
        replay: { ...replay, final },
        rules: [GL009],
        live: buildSnapshot(database()),
      }).findings;
      expect(findings.map((f) => [f.relation, f.file, f.line])).toEqual([
        ['public.todos', FILE, 1],
      ]);
      const seq = Catalog.create(replay.final.defaults).createSequence(
        { schema: 'public', name: 's' },
        'postgres',
        null,
      );
      const withSeq = runRules({
        config: DEFAULT_CONFIG,
        replay: { ...replay, final: seq },
        rules: [GL009],
        live: buildSnapshot(
          database({ relations: [{ schema: 'public', name: 's', relkind: 'S', acl: null }] }),
        ),
      }).findings;
      expect(withSeq.map((f) => [f.relation, f.role, f.file])).toEqual(
        API.map((role) => ['public.s', role, FILE]),
      );
    });
  });

  it('can be ignored per relation with a reason', () => {
    const findings = drift(
      TODOS,
      {},
      {
        ignore: [{ rule: 'GL009', relation: 'todos', reason: 'applied tomorrow' }],
      },
    );
    expect(findings).toEqual([]);
  });

  it('is registered, listed in --help and described in SARIF', () => {
    expect(RULES.map((r) => r.id)).toContain('GL009');
    expect(usage()).toMatch(/^ {2}GL009 {5}drift +warn$/m);
    expect(sarifRules().find((d) => d.id === 'GL009')).toMatchObject({
      name: 'drift',
      defaultConfiguration: { level: 'warning' },
    });
  });
});

function fakeContext(replay: ReturnType<typeof replayWithWindow>) {
  return {
    config: DEFAULT_CONFIG,
    replay,
    files: [],
    enforced: [],
    discovery: [],
    inScope: () => true,
    isClientRole: () => true,
    isServiceOnly: () => false,
  };
}
